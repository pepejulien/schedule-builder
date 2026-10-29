// Roster bookmark, Live board side of a moved driver (Jose 2026-10-23; spec: docs/roster-bookmarklet.md).
// When public/roster.js puts a driver at another start time on Amazon (more drivers than empty rows
// at their time, or their time has no rows there), it opens this app as `#roster-moves=YYYY-MM-DD`
// inside the Fill click. This page signs in and loads that week's Live board + rules engine while
// Amazon is filled, then gets the moves that went in (window.postMessage — only from Amazon's origin)
// and makes each one on the Live board the way the board makes a change: the engine, then one save
// (expected rev, change-log lines). A route moves WITH its count (apply_wave move_count: one route
// less at the old time, one more at the new one, the day's total stays; a driver who was an extra
// at the old time moves as an extra; a time the board has no wave at yet gets one). Nothing else is changed.
//
// checkMovesMsg() / planMoves() are pure (no DOM, no JAJB) so tests/roster_moves_test.mjs runs them.
import { dayLabel, cellRole, allowedOrigins } from './roster-send.js';
import { sundayOf, loadEngine, saveWeek, logLines } from './live/live-model.js';
import { liveRequest } from './solver-client.js';
import { onFirebase, canLive, liveWeek } from './api.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
export const SCHED_RE = /^(1[0-2]|[1-9]):[0-5]\d [AP]M$/;   // a schedule time, "10:05 AM"
const NOTE = 'to match Amazon';                               // in the change-log line
const TRIES = 3;                                               // reads again after "someone saved first"

export function rosterMovesHashDate(hash = (typeof location !== 'undefined' ? location.hash : '')) {
  const m = String(hash || '').match(/^#roster-moves=(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

// roster.js's message -> {moves: [{name, tid, from, to}], rev} or {error} (plain words).
export function checkMovesMsg(d, iso) {
  if (!d || typeof d !== 'object' || d.type !== 'jajb-roster-moves') return { error: 'That wasn\'t a list of moves.' };
  if (!ISO_RE.test(String(d.date || '')) || d.date !== iso) {
    return { error: `Amazon's page sent moves for ${ISO_RE.test(String(d.date || '')) ? dayLabel(d.date) : 'another day'}, but this window is for ${dayLabel(iso)}.` };
  }
  if (!Array.isArray(d.moves) || d.moves.length > 200) return { error: 'The list of moves didn\'t come through.' };
  const moves = [];
  for (const m of d.moves) {
    const name = m && typeof m.name === 'string' ? m.name.trim() : '';
    if (!name || name.length > 120 || !SCHED_RE.test(m.from) || !SCHED_RE.test(m.to) || m.from === m.to) {
      return { error: 'A move in the list didn\'t make sense, so nothing was changed.' };
    }
    moves.push({ name, tid: typeof m.tid === 'string' && m.tid.trim() ? m.tid.trim() : null, from: m.from, to: m.to });
  }
  return { moves, rev: typeof d.rev === 'number' ? d.rev : null };
}

const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// What to do for each move on the engine's week (its report, or a saved summary — the same
// drivers[].cells / days[].waves): [{name, from, to, payload?} | {name, from, to, why}] in the
// moves' order, payload = the apply_wave call. {error} when the day itself is wrong.
export function planMoves(rep, iso, moves) {
  const day = ((rep && rep.days) || []).find((x) => x.date === iso);
  if (!day) return { error: `${dayLabel(iso)} isn't in this Live board week.`, steps: [] };
  if (day.open === false) return { error: `${dayLabel(iso)} is closed on the Live board.`, steps: [] };
  const drivers = (rep.drivers || []);
  const seen = new Set();
  const steps = moves.map((mv) => {
    const s = { name: mv.name, from: mv.from, to: mv.to };
    const drv = drivers.find((x) => x.name === mv.name)
      || (mv.tid && drivers.find((x) => String(x.tid || '').trim() === mv.tid))
      || drivers.find((x) => fold(x.name) === fold(mv.name));
    if (!drv) { s.why = 'not on the Live board week any more'; return s; }
    if (seen.has(drv.name)) { s.why = 'in the list twice'; return s; }
    seen.add(drv.name);
    const c = cellRole((drv.cells || {})[day.day]);
    // the engine never splits a training pair (apply_wave: "training days can only be changed by a rebuild")
    if (c.role === 'trainee' || c.role === 'trainer') {
      s.why = `in a training pair${c.partner && c.partner !== 'ride-along' ? ` with ${c.partner}` : ''} — the trainee and trainer can't be moved apart`;
      return s;
    }
    if (c.role !== 'route' || c.sched !== mv.from) { s.why = `the Live board changed — not at ${mv.from} any more`; return s; }
    // a start time the board has no wave at yet is fine: the engine adds it (Jose 2026-10-29)
    s.payload = { day: day.day, name: drv.name, wave: mv.to, move_count: true, note: NOTE };
    return s;
  });
  return { dayName: day.day, steps };
}

// ---------------------------------------------------------------- the page --
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// Draws the small plain screen into `root` and runs the hand-off.
export function startRosterMovesPage(root, iso) {
  document.title = 'Live board: match Amazon';
  root.textContent = '';
  const card = el('div', 'card login');
  card.style.textAlign = 'left';
  card.style.margin = '24px auto';
  card.append(el('h2', null, 'Live board: match Amazon'), el('p', 'hint', dayLabel(iso)));
  const status = el('div', 'banner info', 'Getting the Live board ready…');
  const list = el('div');
  card.append(status, list);
  root.append(card);
  const say = (kind, text) => { status.className = 'banner ' + kind; status.textContent = text; };

  const opener = window.opener && !window.opener.closed ? window.opener : null;
  if (!opener) { say('info', 'Opened directly, so there is nothing to do — the roster bookmark on Amazon\'s page opens this window.'); return; }
  let got = false, timer = null, changed = false;
  const post = (msg) => { for (const o of allowedOrigins()) { try { opener.postMessage(msg, o); } catch { /* closed */ } } };

  // the week + its engine, loaded while Amazon is being filled: {d, rep} (throws plain words)
  const week = sundayOf(iso);
  async function readAndLoad() {
    const d = await liveWeek(week);
    if (!d) throw new Error(`No Live board for that week (week of ${dayLabel(week)}).`);
    if (!d.engine) throw new Error('That Live board week has no rules engine saved.');
    const rep = await loadEngine(week, d.engine, 'live', { summary: JSON.parse(d.summary) });
    return { d, rep };
  }
  const prep = (async () => {
    if (!onFirebase() || !canLive()) throw new Error('This runs on the JAJB site (jajb-ops.web.app/schedule/).');
    const J = window.JAJB;
    await J.ready;
    if (!J.user()) throw new Error('Not signed in — open jajb-ops.web.app and sign in.');
    await J.waitMe();
    if (!J.has('schedule')) throw new Error('Your login doesn\'t include the Schedule Builder.');
    return readAndLoad();
  })();
  prep.then(() => { if (!got) say('info', 'Live board ready — waiting for Amazon\'s page to finish filling…'); },
    (e) => { if (!got) say('err', 'Live board NOT ready: ' + (e.message || e)); });

  // the moves, one engine call each, then one save; a save someone else beat is read again and redone
  async function apply(moves, sentRev) {
    let ctx = await prep;
    for (let t = 0; t < TRIES; t++) {
      if (sentRev != null && ctx.d.meta.rev !== sentRev) changed = true;
      const plan = planMoves(ctx.rep, iso, moves);
      if (plan.error) return moves.map((m) => ({ name: m.name, ok: false, why: plan.error }));
      const out = plan.steps.map((s) => ({ name: s.name, ok: false, why: s.why || '', to: s.to }));
      let rep = ctx.rep;
      for (const [k, s] of plan.steps.entries()) {
        if (!s.payload) continue;
        const m = await liveRequest('apply_wave', s.payload);
        if (!m.ok) { out[k].why = (m.error && m.error.message) || 'the rules engine said no'; continue; }
        rep = m.report; out[k].ok = true; out[k].why = '';
      }
      if (!out.some((r) => r.ok)) return out;
      const lines = logLines(ctx.rep.edits, rep.edits, 'wave');
      try {
        await saveWeek({ weekISO: week, meta: ctx.d.meta, report: rep, expectRev: ctx.d.meta.rev, log: lines });
        return out;
      } catch (e) {
        const last = e.code !== 'conflict' || t === TRIES - 1;
        if (last) {
          const why = e.code === 'conflict' ? 'someone else kept changing the Live board — not saved' : 'not saved — ' + (e.message || e);
          return out.map((r) => (r.ok ? { ...r, ok: false, why } : r));
        }
        changed = true;
        ctx = await readAndLoad();                     // the saved version replaces our unsaved change
      }
    }
    return moves.map((m) => ({ name: m.name, ok: false, why: 'not saved' }));
  }

  function show(results, error) {
    list.textContent = '';
    const ul = el('ul', 'hint');
    for (const r of results) ul.append(el('li', null, r.ok ? `${r.name} → ${r.to}` : `NOT moved: ${r.name} — ${r.why}`));
    if (results.length) list.append(ul);
    if (changed) list.append(el('p', 'hint', 'The Live board had changed since Amazon\'s page read it — each driver was checked again first.'));
    const bad = error || results.some((r) => !r.ok);
    if (error) say('err', 'Live board NOT updated: ' + error);
    else if (!results.length) say('ok', 'Nothing to change on the Live board — this window closes by itself.');
    else if (bad) say('err', 'Not every driver was moved on the Live board — change the rest there by hand. (Amazon\'s page says which.)');
    else say('ok', `Live board updated to match Amazon (${results.length === 1 ? '1 driver' : results.length + ' drivers'}) — this window closes by itself.`);
    if (!bad) setTimeout(() => window.close(), 4000);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== opener || !allowedOrigins().includes(e.origin)) return;
    const d = e.data || {};
    if (d.type !== 'jajb-roster-moves' || got) return;
    got = true; clearInterval(timer);
    const origin = e.origin;
    const reply = (results, error) => {
      const msg = { type: 'jajb-roster-moves-done', date: iso, results: results.map((r) => ({ name: r.name, ok: !!r.ok, ...(r.ok ? {} : { why: r.why }) })) };
      if (error) msg.error = error;
      try { opener.postMessage(msg, origin); } catch { /* closed */ }   // that origin only
      show(results, error);
    };
    const v = checkMovesMsg(d, iso);
    if (v.error) { reply([], v.error); return; }
    if (!v.moves.length) { reply([]); return; }
    say('info', `Moving ${v.moves.length === 1 ? '1 driver' : v.moves.length + ' drivers'} on the Live board…`);
    apply(v.moves, v.rev).then((res) => reply(res), (err) => {
      const why = err && err.message ? err.message : String(err);
      reply(v.moves.map((m) => ({ name: m.name, ok: false, why })), why);
    });
  });
  // keep saying "ready" until roster.js sends the moves (it answers once Amazon is filled)
  post({ type: 'jajb-roster-moves-ready' });
  timer = setInterval(() => { if (!got) post({ type: 'jajb-roster-moves-ready' }); }, 1000);
}

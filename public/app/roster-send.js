// Roster bookmark, app side (Jose 2026-10-09; spec: docs/roster-bookmarklet.md).
// public/roster.js runs inside Amazon's Dispatch page and opens this app as
// `#roster=YYYY-MM-DD` in a small window. This page reads that day off the Live
// board and hands it back with window.postMessage — only ever to Amazon's origin.
//
// rosterForDay() is pure (no DOM, no JAJB) so tests/roster_send_test.mjs can run it
// under Node; the page code below only runs when startRosterPage() is called.
import { scheduleToPortal, DAY_FULL } from './lib/waves.js';
import { parseISODate } from './lib/weeks.js';
import { sundayOf, loadEngine, saveWeek, logLines, summaryFromReport } from './live/live-model.js';
import { onFirebase, canLive, liveSummaryOnce, liveWeek } from './api.js';
import { liveRequest } from './solver-client.js';

export const AMAZON_ORIGIN = 'https://logistics.amazon.com';
// Local testing: set localStorage['jajb-roster-test-origin'] to the test page's
// origin (e.g. 'http://localhost:8790'); that origin is then ALSO accepted and
// answered, alongside Amazon's. Remove the key when done.
const TEST_ORIGIN_KEY = 'jajb-roster-test-origin';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WAVE_RE = /^(\d{1,2}:\d{2} [AP]M)/;       // runner.py _WAVE_RE, anchored like .match()
const MARK_RE = /^(Called out|No-show|Day off)$/;

const shortName = (n) => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1]}` : String(n || '').trim(); };
const waveMins = (w) => { const m = String(w).match(/(\d{1,2}):(\d{2}) ([AP]M)/); if (!m) return 9999;
  return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2]; };

// "Saturday Oct 10"
export function dayLabel(iso) {
  const d = parseISODate(iso);
  const dn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${DAY_FULL[dn]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// What one cell means for the DA boxes: {role: route|trainee|trainer|backup|null, sched, partner}
export function cellRole(v) {
  const s = String(v || '').trim();
  const m = s.match(WAVE_RE);
  if (!s || !m || MARK_RE.test(s) || /meeting/i.test(s)) return { role: null };
  const partner = (s.match(/w\/ ([^)]+)\)/) || [])[1] || '';
  if (/TRAIN helper/.test(s)) return { role: 'trainer', sched: m[1], partner };
  if (/TRAIN drives/.test(s)) return { role: 'trainee', sched: m[1], partner };
  if (/Backup/.test(s)) return { role: 'backup', sched: m[1] };
  return { role: 'route', sched: m[1] };
}

// The day's DA list from a Live board summary (live-model.js summaryFromReport).
// summary.days = [{day: 'Sat', date: ISO, open, ...}], drivers[].cells keyed by day name.
// Returns {date, week, label, dayName, drivers, skipped, error}; error is plain words or null.
export function rosterForDay(summary, iso) {
  const out = { date: iso, week: summary && summary.week || null, label: summary && summary.label || '',
    dayName: null, drivers: [], skipped: [], error: null };
  const day = ((summary && summary.days) || []).find((d) => d.date === iso);
  if (!day) { out.error = `${dayLabel(iso)} isn't in this Live board week.`; return out; }
  out.dayName = day.day;
  if (day.open === false) { out.error = `${dayLabel(iso)} is closed on the Live board — no routes that day.`; return out; }
  const all = (summary.drivers || []).map((d, i) => ({ d, i, c: cellRole((d.cells || {})[day.day]) }));
  // a trainee's cell names the trainer by short name; give the full name when we can find them
  const trainerOf = (x) => {
    const t = all.find((y) => y.c.role === 'trainer' && shortName(y.d.name) === x.c.partner
      && (!y.c.partner || y.c.partner === 'ride-along' || y.c.partner === shortName(x.d.name)));
    return t ? t.d.name : (x.c.partner || null);
  };
  const rows = [];
  for (const x of all) {
    const { role, sched } = x.c;
    if (role === 'route' || role === 'trainee') {
      rows.push({ i: x.i, w: waveMins(sched), v: { name: x.d.name, tid: (x.d.tid && String(x.d.tid).trim()) || null,
        sched, portal: scheduleToPortal(sched), trainee: role === 'trainee', trainer: role === 'trainee' ? trainerOf(x) : null } });
    } else if (role === 'trainer') out.skipped.push({ name: x.d.name, why: 'Trainer' });
    else if (role === 'backup') out.skipped.push({ name: x.d.name, why: 'Backup' });
  }
  rows.sort((a, b) => a.w - b.w || a.i - b.i);
  out.drivers = rows.map((r) => r.v);
  if (!out.drivers.length) out.error = `Nobody is on a route ${dayLabel(iso)} on the Live board.`;
  return out;
}

// ---------------------------------------------------------------- the page --
export function rosterHashDate(hash = (typeof location !== 'undefined' ? location.hash : '')) {
  const m = String(hash || '').match(/^#roster=(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

// (also the moves window, roster-moves.js — Jose 2026-10-23)
export function allowedOrigins() {
  const o = [AMAZON_ORIGIN];
  try { const t = localStorage.getItem(TEST_ORIGIN_KEY); if (t) o.push(t); } catch { /* private window */ }
  return o;
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// roster.js's "make these Live board changes" -> {picks: [{kind, name, with?}], rev} or {error}
// (Jose 2026-11-12: the checklist dispatch ticked on Amazon's page).
export function checkApplyMsg(d, iso) {
  if (!d || typeof d !== 'object' || d.type !== 'jajb-roster-apply') return { error: 'That wasn\'t a list of changes.' };
  if (d.date !== iso) return { error: 'Those changes were for another day, so nothing was changed.' };
  if (!Array.isArray(d.picks) || !d.picks.length || d.picks.length > 100) return { error: 'The list of changes didn\'t come through.' };
  const bad = { error: 'A change in the list didn\'t make sense, so nothing was changed.' };
  const okName = (n) => typeof n === 'string' && !!n.trim() && n.length <= 120;
  const picks = [];
  for (const p of d.picks) {
    if (!p || !['backup', 'route', 'six'].includes(p.kind) || !okName(p.name)) return bad;
    const x = { kind: p.kind, name: p.name.trim() };
    if (p.kind === 'six' && p.with != null) {
      if (!okName(p.with)) return bad;
      x.with = p.with.trim();
    }
    picks.push(x);
  }
  return { picks, rev: typeof d.rev === 'number' ? d.rev : null };
}

// Draws the small plain screen into `root` and runs the hand-off.
// Since 2026-11-12 the request carries Amazon's row count (`rows`): this page loads the week's
// rules engine and adds the plan (engine roster_plan: who goes to backup / gets a route, 6-day
// risks). When dispatch ticks changes on Amazon's page they come back as `jajb-roster-apply`;
// they are made here (engine roster_apply, one save) and the day is sent again, fresh.
export function startRosterPage(root, iso) {
  document.title = 'Roster to Amazon';
  root.textContent = '';
  const card = el('div', 'card login');
  card.style.textAlign = 'left';
  card.style.margin = '24px auto';
  card.append(el('h2', null, 'Roster to Amazon'), el('p', 'hint', dayLabel(iso)));
  const status = el('div', 'banner info', 'Loading the Live board…');
  const list = el('div');
  card.append(status, list);
  root.append(card);
  const say = (kind, text) => { status.className = 'banner ' + kind; status.textContent = text; };

  const opener = window.opener && !window.opener.closed ? window.opener : null;
  let base = null, answered = false, applying = false, timer = null;
  const week = sundayOf(iso);

  const post = (msg) => { if (!opener) return; for (const o of allowedOrigins()) { try { opener.postMessage(msg, o); } catch { /* closed */ } } };
  const showDrivers = (p) => {
    list.textContent = '';
    const ul = el('ul', 'hint');
    for (const d of p.drivers) ul.append(el('li', null, `${d.portal} — ${d.name}${d.trainee ? ` (trainee, with ${d.trainer || 'trainer'})` : ''}`));
    list.append(ul);
    if (p.skipped.length) list.append(el('p', 'hint', 'Not in a DA box: ' + p.skipped.map((s) => `${s.name} (${s.why.toLowerCase()})`).join(', ')));
  };
  const dayPayload = (summary, rev) => {
    const r = rosterForDay(summary, iso);
    return { type: 'jajb-roster', date: iso, week, rev, label: r.label, dayName: r.dayName, drivers: r.drivers, skipped: r.skipped, error: r.error };
  };

  // the week + its engine (the plan and the changes need it): {d, rep}; throws plain words
  async function readAndLoad() {
    const d = await liveWeek(week);
    if (!d) throw new Error(`No Live board for that week (week of ${dayLabel(week)}).`);
    if (!d.engine) throw new Error('That Live board week has no rules engine saved.');
    const rep = await loadEngine(week, d.engine, 'live', { summary: JSON.parse(d.summary) });
    return { d, rep };
  }
  let eng = null;                                     // a promise of {d, rep}, started once the day is read

  // the plan for Amazon's row count -> {plan, planError}
  async function planFor(rows, dayName) {
    try {
      const ctx = await eng;
      const m = await liveRequest('roster_plan', { day: dayName, rows });
      if (!m.ok) return { plan: null, planError: m.error.message };
      return { plan: { ...m.data, rev: ctx.d.meta.rev }, planError: null };
    } catch (e) { return { plan: null, planError: e.message || String(e) }; }
  }

  // the ticked changes: one engine call, one save; a save someone else beat is read again and redone
  async function apply(picks, dayName) {
    let ctx = await eng;
    for (let t = 0; t < 3; t++) {
      const m = await liveRequest('roster_apply', { day: dayName, picks });
      if (!m.ok) throw new Error(m.error.message);
      const rep = m.report, results = rep.roster_results || [];
      if (!results.some((r) => r.ok)) return { results, payload: null };
      try {
        const { rev } = await saveWeek({ weekISO: week, meta: ctx.d.meta, report: rep, expectRev: ctx.d.meta.rev,
          log: logLines(ctx.rep.edits, rep.edits, 'role') });
        const meta = { ...ctx.d.meta, rev };
        eng = Promise.resolve({ d: { ...ctx.d, meta }, rep });
        const summary = summaryFromReport(rep, { week, label: meta.label || '', num: parseInt(meta.num, 10) || 0 });
        return { results, payload: dayPayload(summary, rev) };
      } catch (e) {
        if (e.code !== 'conflict' || t === 2) {
          const why = e.code === 'conflict' ? 'someone else kept changing the Live board — not saved' : 'not saved — ' + (e.message || e);
          return { results: results.map((r) => (r.ok ? { ...r, ok: false, why } : r)), payload: null };
        }
        ctx = await readAndLoad();                     // the saved version replaces our unsaved change
        eng = Promise.resolve(ctx);
      }
    }
    return { results: picks.map((p) => ({ ...p, ok: false, why: 'not saved' })), payload: null };
  }

  window.addEventListener('message', async (e) => {
    if (!opener || e.source !== opener || !allowedOrigins().includes(e.origin)) return;
    const d = e.data || {};
    const origin = e.origin;
    if (d.type === 'jajb-roster-request' && base && !answered) {
      answered = true; clearInterval(timer);
      let p = base;
      if (!p.error && eng) {
        say('info', 'Checking who should have a route…');
        const rows = Number.isInteger(d.rows) && d.rows >= 0 ? d.rows : null;
        p = { ...p, ...(await planFor(rows, p.dayName)) };
      }
      opener.postMessage(p, origin);                     // that origin only
      if (p.error) { say('err', p.error + ' (sent to Amazon)'); return; }
      const n = ((p.plan && p.plan.changes) || []).length;
      if (n) { say('info', `Sent ${dayLabel(iso)} to Amazon. Keep this window open — Amazon's page lists ${n} Live board change${n === 1 ? '' : 's'} to tick.`); return; }
      say('ok', `Sent ${dayLabel(iso)} to Amazon — this window closes by itself.`);
      setTimeout(() => window.close(), 3000);
      return;
    }
    if (d.type === 'jajb-roster-apply' && answered && !applying && base && !base.error) {
      applying = true;
      const reply = (msg) => { try { opener.postMessage({ type: 'jajb-roster-applied', date: iso, ...msg }, origin); } catch { /* closed */ } };
      const v = checkApplyMsg(d, iso);
      if (v.error) { say('err', v.error); reply({ results: [], error: v.error }); applying = false; return; }
      say('info', `Changing the Live board (${v.picks.length} change${v.picks.length === 1 ? '' : 's'})…`);
      try {
        const out = await apply(v.picks, base.dayName);
        reply({ results: out.results, payload: out.payload });
        if (out.payload) showDrivers(out.payload);
        const bad = out.results.some((r) => !r.ok || r.with_ok === false);
        if (bad || !out.payload) say('err', 'Not every change was made — Amazon\'s page says which. Change the rest on the Live board by hand.');
        else { say('ok', 'Live board updated — this window closes by itself.'); setTimeout(() => window.close(), 4000); }
      } catch (err) {
        const why = err && err.message ? err.message : String(err);
        say('err', 'Live board NOT changed: ' + why);
        reply({ results: [], error: why });
      }
      applying = false;
    }
  });
  // once the day (or an error) is ready: say so, and keep saying it until roster.js asks
  const ready = (p) => {
    base = p;
    if (!opener) return;
    post({ type: 'jajb-roster-ready' });
    timer = setInterval(() => { if (!answered) post({ type: 'jajb-roster-ready' }); }, 1000);
  };
  const fail = (msg) => { say('err', msg + (opener ? '' : ' (opened directly — nothing is sent)')); ready({ type: 'jajb-roster', date: iso, drivers: [], skipped: [], error: msg }); };

  (async () => {
    if (!onFirebase()) return fail('The roster bookmark runs on the JAJB site (jajb-ops.web.app/schedule/).');
    const J = window.JAJB;
    await J.ready;
    if (!J.user()) return fail('Not signed in — open jajb-ops.web.app, sign in, then click the bookmark again.');
    await J.waitMe();
    if (!J.has('schedule')) return fail('Your login doesn\'t include the Schedule Builder. Ask Jose if you need it.');
    let summary = null, rev = null;
    try {
      const doc = await liveSummaryOnce(week, () => true, 8000);
      if (doc) { summary = JSON.parse(doc.json); rev = doc.rev ?? null; }
      else if (doc === undefined) {                       // no answer in time: read the week
        const w = await liveWeek(week);
        if (w) { summary = JSON.parse(w.summary); rev = w.meta.rev; }
      }
    } catch (e) { return fail('Could not read the Live board: ' + (e.message || e)); }
    if (!summary) return fail(`No Live board for that week (week of ${dayLabel(week)}) — publish it first.`);
    const p = dayPayload(summary, rev);
    if (p.error) { say('err', p.error + (opener ? '' : ' (opened directly — nothing is sent)')); ready(p); return; }
    // the rules engine loads while Amazon's page gets ready; if it can't, the day still
    // rosters, just without the plan (Amazon's page says why)
    if (opener && canLive()) { eng = readAndLoad(); eng.catch(() => {}); }
    const n = p.drivers.length;
    say('info', opener ? `${n} driver${n === 1 ? '' : 's'} ready — waiting for Amazon's page to ask…`
      : `${n} driver${n === 1 ? '' : 's'} on routes. Opened directly, so nothing is sent — click the bookmark on Amazon's page to fill it.`);
    showDrivers(p);
    ready(p);
  })().catch((e) => fail('Something went wrong: ' + (e.message || e)));
}

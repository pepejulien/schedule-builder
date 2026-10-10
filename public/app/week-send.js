// "📅 Week to Amazon" bookmark, app side (Jose 2026-10-09; spec: docs/week-bookmarklet.md).
// public/schedweek.js runs inside Amazon's Scheduling week view and opens this app as
// `#schedweek=YYYY-MM-DD` (the week's Sunday) in a small window. This page reads that week off
// the Live board and hands every driver's shifts back with window.postMessage — only ever to
// Amazon's origin. Same hand-off as the Roster bookmark (roster-send.js), its own message types.
//
// weekForAmazon() is pure (no DOM, no JAJB) so tests/week_send_test.mjs runs it under Node.
import { parseISODate } from './lib/weeks.js';
import { onFirebase, liveSummaryOnce, liveWeek } from './api.js';
import { AMAZON_ORIGIN } from './roster-send.js';

const TEST_ORIGIN_KEY = 'jajb-roster-test-origin';     // same local-test switch as the Roster bookmark
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WAVE_RE = /^(\d{1,2}:\d{2} [AP]M)/;
const MARK_RE = /^(Called out|No-show|Day off|Unavailable)$/;

// One schedule cell -> the Amazon shift it becomes (Jose 2026-10-09: "everything"):
//   route / trainee / backup -> {kind: 'driver', time}   ("Driver • 10:05 AM • 9h 50m")
//   trainer                  -> {kind: 'helper', time}   ("Helper 10:05 AM")
//   Dispatch                 -> {kind: 'dispatcher'}     ("Dispatcher • 9:15 AM • 12h")
//   a meeting                -> {kind: 'meeting'}        ("Meeting")
// Our times are the SCHEDULE times, the same as Amazon's Scheduling shifts (Dispatch's route blocks
// are 20 min later - that's the Roster bookmark's business). Blank, Unavailable, marks -> null.
export function amazonShift(v) {
  const s = String(v || '').trim();
  if (!s || MARK_RE.test(s)) return null;
  if (s === 'Dispatch') return { kind: 'dispatcher', what: 'Dispatch' };
  if (/meeting/i.test(s)) return { kind: 'meeting', what: 'Meeting' };
  const m = s.match(WAVE_RE);
  if (!m) return null;
  if (/TRAIN helper/.test(s)) return { kind: 'helper', time: m[1], what: 'Trainer' };
  if (/TRAIN drives/.test(s)) return { kind: 'driver', time: m[1], what: 'Trainee' };
  if (/Backup/.test(s)) return { kind: 'driver', time: m[1], what: 'Backup' };
  return { kind: 'driver', time: m[1], what: 'Route' };
}

// The week as Amazon's page needs it, from a Live board summary (live-model.js summaryFromReport):
// {week, label, days: [{day, date, open}], drivers: [{name, tid, shifts: {Sun: {kind, time?, what}}}],
//  error}. Only drivers with at least one shift. error is plain words or null.
export function weekForAmazon(summary) {
  const out = { week: (summary && summary.week) || null, label: (summary && summary.label) || '',
    days: [], drivers: [], error: null };
  out.days = ((summary && summary.days) || []).map((d) => ({ day: d.day, date: d.date, open: d.open !== false }));
  if (out.days.length !== 7) { out.error = "That Live board week doesn't have 7 days."; return out; }
  for (const d of (summary.drivers || [])) {
    const shifts = {};
    for (const day of out.days) {
      if (!day.open) continue;
      const sh = amazonShift((d.cells || {})[day.day]);
      if (sh) shifts[day.day] = sh;
    }
    if (Object.keys(shifts).length) {
      out.drivers.push({ name: d.name, tid: (d.tid && String(d.tid).trim()) || null, shifts });
    }
  }
  if (!out.drivers.length) out.error = 'Nobody has a shift that week on the Live board.';
  return out;
}

// ---------------------------------------------------------------- the page --
export function weekHashDate(hash = (typeof location !== 'undefined' ? location.hash : '')) {
  const m = String(hash || '').match(/^#schedweek=(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

function allowedOrigins() {
  const o = [AMAZON_ORIGIN];
  try { const t = localStorage.getItem(TEST_ORIGIN_KEY); if (t) o.push(t); } catch { /* private window */ }
  return o;
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const weekText = (sun) => { const a = parseISODate(sun), b = new Date(a); b.setDate(a.getDate() + 6);
  return `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}`; };

// Draws the small plain screen into `root` and runs the hand-off.
export function startWeekPage(root, sunday) {
  document.title = 'Week to Amazon';
  root.textContent = '';
  const card = el('div', 'card login');
  card.style.textAlign = 'left';
  card.style.margin = '24px auto';
  card.append(el('h2', null, 'Week to Amazon'), el('p', 'hint', `Week of ${weekText(sunday)}`));
  const status = el('div', 'banner info', 'Loading the Live board…');
  const list = el('div');
  card.append(status, list);
  root.append(card);
  const say = (kind, text) => { status.className = 'banner ' + kind; status.textContent = text; };

  const opener = window.opener && !window.opener.closed ? window.opener : null;
  let payload = null, answered = false, timer = null;
  const post = (msg) => { if (!opener) return; for (const o of allowedOrigins()) { try { opener.postMessage(msg, o); } catch { /* closed */ } } };
  window.addEventListener('message', (e) => {
    if (!opener || e.source !== opener || !allowedOrigins().includes(e.origin)) return;
    const d = e.data || {};
    if (d.type !== 'jajb-week-request' || !payload || answered) return;
    answered = true; clearInterval(timer);
    opener.postMessage(payload, e.origin);              // that origin only
    if (payload.error) { say('err', payload.error + ' (sent to Amazon)'); return; }
    say('ok', `Sent the week of ${weekText(sunday)} to Amazon — this window closes by itself.`);
    setTimeout(() => window.close(), 3000);
  });
  const ready = (p) => {
    payload = { type: 'jajb-week', ...p };
    if (!opener) return;
    post({ type: 'jajb-week-ready' });
    timer = setInterval(() => { if (!answered) post({ type: 'jajb-week-ready' }); }, 1000);
  };
  const fail = (msg) => { say('err', msg + (opener ? '' : ' (opened directly — nothing is sent)')); ready({ week: sunday, days: [], drivers: [], error: msg }); };

  (async () => {
    if (!onFirebase()) return fail('The week bookmark runs on the JAJB site (jajb-ops.web.app/schedule/).');
    const J = window.JAJB;
    await J.ready;
    if (!J.user()) return fail('Not signed in — open jajb-ops.web.app, sign in, then click the bookmark again.');
    await J.waitMe();
    if (!J.has('schedule')) return fail('Your login doesn\'t include the Schedule Builder. Ask Jose if you need it.');
    let summary = null, rev = null;
    try {
      const doc = await liveSummaryOnce(sunday, () => true, 8000);
      if (doc) { summary = JSON.parse(doc.json); rev = doc.rev ?? null; }
      else if (doc === undefined) {                       // no answer in time: read the week
        const w = await liveWeek(sunday);
        if (w) { summary = JSON.parse(w.summary); rev = w.meta.rev; }
      }
    } catch (e) { return fail('Could not read the Live board: ' + (e.message || e)); }
    if (!summary) return fail(`No Live board for the week of ${weekText(sunday)} — build and publish it first.`);
    const r = weekForAmazon(summary);
    const p = { week: sunday, rev, label: r.label, days: r.days, drivers: r.drivers, error: r.error };
    if (r.error) { say('err', r.error + (opener ? '' : ' (opened directly — nothing is sent)')); ready(p); return; }
    const n = r.drivers.length, shifts = r.drivers.reduce((a, d) => a + Object.keys(d.shifts).length, 0);
    say('info', opener ? `${shifts} shifts for ${n} drivers ready — waiting for Amazon's page to ask…`
      : `${shifts} shifts for ${n} drivers. Opened directly, so nothing is sent — click the bookmark on Amazon's Scheduling page.`);
    list.append(el('p', 'hint', r.label || ''));
    ready(p);
  })().catch((e) => fail('Something went wrong: ' + (e.message || e)));
}


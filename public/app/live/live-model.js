// The Live board's plumbing, kept apart from the screens: what a published
// week looks like in Firestore, and how one change travels engine -> Firestore.
//
// A published week is saved three ways (see jajb.js schedule_weeks):
//   meta     {week, label, num, rev, stats, by, at, publishedBy, publishedAt}
//   summary  the per-driver week as JSON (cells, hours, streak, worked dates) —
//            draws the board before the engine loads, gives next week its real
//            days-in-a-row tail, and is what a drivers' app will read later
//   engine   the schedule engine's whole state (runner.export_state)
import { editRequest } from '../solver-client.js';
import { liveWeek, saveLiveWeek, actualHoursOnce, confirmsOnce, liveSummaryOnce } from '../api.js';
import { parseISODate, toISODate, addDays } from '../lib/weeks.js';
// the limit checks + actual-hours merge live in limits.js (no app imports), so the
// Vehicle Assigner can load them too
import { actualList, missingDays, withConfirmed } from './limits.js';
export { actualList, flKey, mergeActual, overRisk, runRisk, riskCardHtml, roomOn, clockOutBy, missingDays, withConfirmed } from './limits.js';

export const prevISO = (iso) => toISODate(addDays(parseISODate(iso), -7));
export const todayISO = () => toISODate(new Date());

// The week (its Sunday) that contains a date.
export function sundayOf(iso) {
  const d = parseISODate(iso);
  return toISODate(addDays(d, -d.getDay()));
}

const DRIVER_KEYS = ['name', 'cls', 'target', 'hours', 'streak', 'road_days', 'backup_days',
  'helper_days', 'dispatch_days', 'meeting_days', 'unavailable', 'cells', 'worked_dates',
  'day_hours', 'clock_hours', 'max7', 'act_dates'];

export function summaryFromReport(r, meta) {
  const chk = r.check || {};
  return {
    v: 1,
    week: meta.week, label: meta.label, num: meta.num,
    days: r.days || [],
    limits: r.limits || {},
    drivers: (r.drivers || []).map((d) => Object.fromEntries(DRIVER_KEYS.map((k) => [k, d[k] ?? null]))),
    marks: r.marks || [],
    infeasible: r.infeasible || [],
    errors: chk.errors || [],
    overridden: chk.overridden || [],
    max_consec: chk.max_consec ?? null,
    pairlog: r.pairlog || [],
    notes: r.notes || [],
  };
}

// The few numbers the week list shows without loading the week.
export function statsFromReport(r) {
  const days = (r.days || []).filter((d) => d.open);
  return {
    drivers: (r.drivers || []).filter((d) => d.hours > 0).length,
    routes: days.reduce((a, d) => a + d.routes, 0),
    open: days.reduce((a, d) => a + Math.max(0, d.routes - d.routes_filled), 0),
    marks: (r.marks || []).length,
  };
}

// {name: [ISO dates worked]} from a saved summary — next week's tail.
export function prevWorkedFrom(summary) {
  return Object.fromEntries((summary.drivers || []).map((d) => [d.name, d.worked_dates || []]));
}

// {name: {ISO date: hours}} — last week's on-the-clock hours, for the 60h rule.
export function prevHoursFrom(summary) {
  const out = {};
  for (const d of (summary.drivers || [])) if (d.day_hours) out[d.name] = d.day_hours;
  return Object.keys(out).length ? out : null;
}

export const actualSig = (doc) => JSON.stringify((doc && doc.drivers) || null);
// only the "they worked" answers change the hours (the engine reloads when they do)
export const workedSig = (confirms) => JSON.stringify(Object.keys(confirms || {}).filter((k) => confirms[k].answer === 'worked').sort());

// What each week's engine was last loaded with: {cur, prev, confirm (signatures), prevRev}.
export const ACT_LOADED = {};

// Last week's tail ({rev, prev, prevHours}), kept per week (2026-10-08): a week that's over rarely
// changes, so it's read once — its summary doc only, not its engine state — and again only when its
// rev moves. The Live board keeps a listener on it that feeds notePrevSummary.
const NO_TAIL = { rev: null, prev: null, prevHours: null };
const TAILS = {};
// doc = {json, rev} | null (not published). true = the tail changed.
export function notePrevSummary(weekISO, doc) {
  const rev = doc && typeof doc.rev === 'number' ? doc.rev : null;
  const c = TAILS[weekISO];
  if (c && c.rev === rev) return false;
  if (rev === null) { TAILS[weekISO] = NO_TAIL; return true; }
  let sm;
  try { sm = JSON.parse(doc.json); } catch { return false; }
  TAILS[weekISO] = { rev, prev: prevWorkedFrom(sm), prevHours: prevHoursFrom(sm) };
  return true;
}
export const prevTailRev = (weekISO) => (TAILS[weekISO] ? TAILS[weekISO].rev : undefined);

// known = that week's rev as the week list showed it (null: not published, undefined: not known)
async function prevTail(weekISO, known) {
  const c = TAILS[weekISO];
  if (known === null) return c || NO_TAIL;
  if (typeof known === 'number') {
    if (c && c.rev != null && c.rev >= known) return c;
    // a cached copy older than the list can come first: wait for the current one
    const doc = await liveSummaryOnce(weekISO, (d) => !d || d.rev >= known);
    if (doc !== undefined) { notePrevSummary(weekISO, doc); return TAILS[weekISO] || NO_TAIL; }
  }
  // not known (or no answer): read the week, as before
  try {
    const p = await liveWeek(weekISO);
    notePrevSummary(weekISO, p ? { json: p.summary, rev: p.meta.rev } : null);
    return TAILS[weekISO] || NO_TAIL;
  } catch { return c || NO_TAIL; /* no history for last week — keep the builder's tail */ }
}

// Load a saved week into an engine slot. Last week's REAL worked days and
// hours (from its own Live board, if it was published) replace the uploaded
// file's tail.
// opts (the Live board, 2026-10-08): summary = this week's saved summary when the caller has it (no
// second read of the week); prevRev = last week's rev from the week list (see prevTail); live() =
// false once a newer load was asked for — then nothing reaches the engine and this resolves null.
// Every read here runs at once (the board's own listeners usually answer them without a round trip).
export async function loadEngine(weekISO, engineJson, slot = 'live', opts = {}) {
  const pw = prevISO(weekISO);
  // the real hours of days already worked (Route Tracker), this week and last
  const [tail, actCur, actPrev, confirms, cur] = await Promise.all([prevTail(pw, opts.prevRev),
    actualHoursOnce(weekISO), actualHoursOnce(pw), confirmsOnce(weekISO),
    opts.summary ? null : liveWeek(weekISO).catch(() => null)]);
  // a "they worked" answer counts the scheduled hours until Route Tracker has the clock-out
  let actual = actualList(actPrev, actCur);
  try {
    const sm = opts.summary || (cur ? JSON.parse(cur.summary) : null);
    if (sm) actual = withConfirmed(actual, missingDays(sm, actual, confirms), sm.limits || {});
  } catch { /* keep the clock-outs */ }
  if (opts.live && !opts.live()) return null;
  ACT_LOADED[weekISO] = { cur: actualSig(actCur), prev: actualSig(actPrev), confirm: workedSig(confirms), prevRev: tail.rev };
  const m = await editRequest('load_state',
    { state: engineJson, out: `/work/${slot}.xlsx`, prev_worked: tail.prev, prev_hours: tail.prevHours, actual }, slot);
  if (!m.ok) throw Object.assign(new Error(m.error.message), { kind: m.error.kind });
  return m.report;
}

// What changed between two engine reports, as change-log lines.
export function logLines(before, after, kind) {
  const a = before || [], b = after || [];
  if (b.length > a.length) return b.slice(a.length).map((text) => ({ text, kind }));
  if (b.length < a.length) return [{ text: 'Undid: ' + a[a.length - 1], kind: 'undo' }];
  return [{ text: 'Changed the schedule', kind }];
}

// Save the slot's current schedule as `weekISO`. expectRev = the version this
// page last loaded (0 for a week that must not exist yet); a mismatch throws
// err.code === 'conflict'. Resolves {rev, engine} (the saved engine state).
export async function saveWeek({ slot = 'live', weekISO, meta, report, expectRev, log, publish = false }) {
  const ex = await editRequest('export_state', {}, slot);
  if (!ex.ok) throw new Error(ex.error.message);
  const m = { week: weekISO, label: meta.label || '', num: parseInt(meta.num, 10) || 0 };
  const rev = await saveLiveWeek(weekISO, {
    expectRev, label: m.label, num: m.num, publish,
    stats: statsFromReport(report),
    summary: JSON.stringify(summaryFromReport(report, m)),
    engine: ex.data.state,
    log,
  });
  return { rev, engine: ex.data.state };
}

// Amazon's own shift colors (logistics.amazon.com scheduling, 2026-10-06).
export const WAVE_COLORS = { '10:05': '#B5EBF3', '10:25': '#FCDE4D', '10:45': '#FFB5CA', '11:05': '#78D9CF', '11:25': '#FCDE4D' };
export const SHIFT_COLORS = { trainer: '#FFA28A', disp: '#C3EB5E', meet: '#E9C6E4', off: '#D5DBDB',
  mark: 'rgba(255,121,121,.73)', other: '#DCE3F0' };
const waveColor = (w) => WAVE_COLORS[w] || SHIFT_COLORS.other;

// One grid cell as Amazon draws it: {kind, top, sub, bg, partner}.
// kind: road | bk | trainee | trainer | disp | meet | off | mark | empty
export function cellInfo(v) {
  const s = String(v || '');
  if (!s) return { kind: 'empty', top: '', sub: '' };
  const m = s.match(/^(\d{1,2}:\d{2}) ([AP]M)/);
  const wave = m ? m[1] : null;
  const time = m ? `${m[1]} ${m[2]}` : '';
  const partner = (s.match(/w\/ ([^)]+)\)/) || [])[1] || '';
  if (/^(Called out|No-show|Day off)$/.test(s)) return { kind: 'mark', top: s, sub: '', bg: SHIFT_COLORS.mark };
  // "1:00 PM Meeting" has a time but is no route
  if (/meeting/i.test(s)) return { kind: 'meet', top: time || 'Meeting', sub: time ? 'Meeting' : '', bg: SHIFT_COLORS.meet };
  if (/TRAIN helper/.test(s)) return { kind: 'trainer', top: time, sub: 'Trainer', partner, bg: SHIFT_COLORS.trainer };
  if (/TRAIN drives/.test(s)) return { kind: 'trainee', top: time, sub: 'Trainee', partner, bg: waveColor(wave) };
  if (/Backup/.test(s)) return { kind: 'bk', top: time || 'Backup', sub: time ? 'Backup' : '', bg: waveColor(wave) };
  if (wave) return { kind: 'road', top: time, sub: '', bg: waveColor(wave) };
  if (s === 'Unavailable') return { kind: 'off', top: 'Unavailable', sub: '', bg: SHIFT_COLORS.off };
  if (s === 'Dispatch') return { kind: 'disp', top: 'Dispatch', sub: '', bg: SHIFT_COLORS.disp };
  return { kind: 'meet', top: s, sub: '', bg: SHIFT_COLORS.meet };
}

// Short text for a grid cell.
export function cellText(v) {
  const s = String(v || '');
  if (!s) return '';
  if (/TRAIN drives/.test(s)) return 'Train ' + (s.match(/^\d{1,2}:\d{2}/) || [''])[0];
  if (/TRAIN helper/.test(s)) return 'Trainer ' + (s.match(/^\d{1,2}:\d{2}/) || [''])[0];
  let m = s.match(/^(\d{1,2}:\d{2}) [AP]M Backup$/);
  if (m) return 'Bk ' + m[1];
  m = s.match(/^(\d{1,2}:\d{2}) [AP]M$/);
  if (m) return m[1];
  if (s === 'Unavailable') return 'off';
  return s;
}

export function cellKind(v) {
  const s = String(v || '');
  if (!s) return 'empty';
  if (/^(Called out|No-show|Day off)$/.test(s)) return 'mark';
  if (/TRAIN/.test(s)) return 'train';
  if (/Backup/.test(s)) return 'bk';
  if (/^\d{1,2}:\d{2} [AP]M/.test(s)) return 'road';
  if (s === 'Unavailable') return 'off';
  if (s === 'Dispatch') return 'disp';
  return 'meet';
}

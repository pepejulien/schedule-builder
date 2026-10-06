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
import { liveWeek, saveLiveWeek } from '../api.js';
import { parseISODate, toISODate, addDays } from '../lib/weeks.js';

export const prevISO = (iso) => toISODate(addDays(parseISODate(iso), -7));
export const todayISO = () => toISODate(new Date());

// The week (its Sunday) that contains a date.
export function sundayOf(iso) {
  const d = parseISODate(iso);
  return toISODate(addDays(d, -d.getDay()));
}

const DRIVER_KEYS = ['name', 'cls', 'target', 'hours', 'streak', 'road_days', 'backup_days',
  'helper_days', 'dispatch_days', 'meeting_days', 'unavailable', 'cells', 'worked_dates'];

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

// Load a saved week into an engine slot. Last week's REAL worked days (from
// its own Live board, if it was published) replace the uploaded file's tail.
export async function loadEngine(weekISO, engineJson, slot = 'live') {
  let prev = null;
  try {
    const p = await liveWeek(prevISO(weekISO));
    if (p) prev = prevWorkedFrom(JSON.parse(p.summary));
  } catch { /* no history for last week — keep the builder's tail */ }
  const m = await editRequest('load_state',
    { state: engineJson, out: `/work/${slot}.xlsx`, prev_worked: prev }, slot);
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

// Short text for a grid cell.
export function cellText(v) {
  const s = String(v || '');
  if (!s) return '';
  if (/TRAIN drives/.test(s)) return 'Train ' + (s.match(/^\d{1,2}:\d{2}/) || [''])[0];
  if (/TRAIN helper/.test(s)) return 'Ride-along';
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

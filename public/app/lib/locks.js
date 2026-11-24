// Locked days (Jose 2026-11-20, team idea #PANyWj52pujmWTe0q9Q0 / card #1360): a manager pins a driver to
// work a date in a week not published yet — e.g. a trainee and their trainer on Tue 12/1. Stored on their own
// (Firestore schedule_locks/{weekStart}, api.js watchLocks), never inside the built week, so a rebuild keeps
// them. The weekly build places every lock first and never moves it (solver locked_days); the lock wins over
// the driver's unavailable days for that date only — their saved preferences and time-off records stay as
// they are. Pure helpers here, shared by the future-week grid, the Live board and the build.
//   lock = {driverKey, date (YYYY-MM-DD), note, training (bool), trainer ('' = the builder picks), by, at,
//           shift ('route' | 'meeting' | 'dispatch', 2026-11-24), time ('' = any | 'h:mm AM'), label (meeting name)}
//   locks = {"<date>|<driverKey>": lock}
import { matchName } from './names.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// name matching as the board does it: case and accents don't count ("jose" finds "José")
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export const lockId = (date, name) => `${date}|${name}`;

// What a lock has them come in for (2026-11-24): 'route' (default) | 'meeting' | 'dispatch'.
export const lockShift = (l) => (l && (l.shift === 'meeting' || l.shift === 'dispatch') ? l.shift : 'route');
// "9:00 AM Safety Meeting" — the meeting's cell, as the board and the build write it (always says "Meeting")
export function meetingText(l) {
  const lab = String((l && l.label) || '').trim() || 'Meeting';
  return `${(l && l.time) || ''} ${/meeting/i.test(lab) ? lab : lab + ' Meeting'}`.trim();
}
// Short words for a lock: "Meeting 9:00 AM", "Dispatch", "Route 8:20 AM", "Training", "Working".
export function lockShort(l) {
  const k = lockShift(l);
  if (k === 'meeting') return meetingText(l);
  if (k === 'dispatch') return 'Dispatch';
  return `${l && l.training ? 'Training' : l && l.time ? 'Route' : 'Working'}${l && l.time ? ' ' + l.time : ''}`;
}
// "Locked: meeting at 9:00 AM" etc., the longer line
export function lockLine(l) {
  const k = lockShift(l);
  if (k === 'meeting') return `Locked: ${meetingText(l).replace(/^\S+ [AP]M /, '')} at ${l.time}`;
  if (k === 'dispatch') return 'Locked: Dispatch';
  if (l && l.training) return `Locked training day${l.time ? ' at ' + l.time : ''}`;
  return l && l.time ? `Locked: route at ${l.time}` : 'Locked: working this day';
}

// "Tue 11/24" for a YYYY-MM-DD
export function dayText(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${DAYS[dt.getDay()]} ${m}/${d}`;
}
const weekday = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return DAYS[new Date(y, m - 1, d).getDay()]; };

// The locks in [weekISO, end of that week] that are well formed, as a list sorted by date then name.
export function lockList(locks, weekISO) {
  const [y, m, d] = String(weekISO).split('-').map(Number);
  const e = new Date(y, m - 1, d + 6);
  const end = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
  return Object.values(locks || {})
    .filter((l) => l && l.driverKey && /^\d{4}-\d{2}-\d{2}$/.test(String(l.date || '')) && l.date >= weekISO && l.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.driverKey).localeCompare(String(b.driverKey))));
}

// The lock on one driver's date, or null.
export function lockOf(locks, name, date) {
  const f = fold(name);
  return Object.values(locks || {}).find((l) => l && l.date === date && fold(l.driverKey) === f) || null;
}

// {fold(name): {date: lock}} — for drawing a grid.
export function locksByDriver(locks) {
  const out = {};
  for (const l of Object.values(locks || {})) {
    if (!l || !l.driverKey || !l.date) continue;
    (out[fold(l.driverKey)] = out[fold(l.driverKey)] || {})[l.date] = l;
  }
  return out;
}
export const foldName = fold;

// What a lock on (name, date) runs into: a day off on file (schedule_timeoff: approved) or a day-off review the
// Driver app sent (timeoff_reviews: pending or approved). -> [{kind: 'timeoff' | 'review', status, note, text}]
// timeoff = {"<ISO>|<name>": {name, day, note}}; reviews = [{name, day, status, note}].
export function lockConflicts(name, date, { timeoff, reviews } = {}) {
  const f = fold(name);
  const out = [];
  for (const t of Object.values(timeoff || {})) {
    if (t && t.day === date && fold(t.name) === f) {
      out.push({ kind: 'timeoff', status: 'approved', note: String(t.note || '').trim(), text: 'approved time off' });
    }
  }
  for (const r of reviews || []) {
    if (!r || r.day !== date || fold(r.name) !== f || (r.status !== 'pending' && r.status !== 'approved')) continue;
    if (r.status === 'approved' && out.some((x) => x.kind === 'timeoff')) continue;   // the same day off, applied
    out.push({ kind: 'review', status: r.status, note: String(r.note || '').trim(),
      text: r.status === 'pending' ? 'a time-off request waiting for review' : 'approved time off (Driver app)' });
  }
  return out;
}

// "Has approved time off on Tue 11/24 (“Doctor”), lock anyway?" — who = '' for the driver, or 'Trainer Jon Judd'.
export function conflictLine(c, date, who = '') {
  return `${who ? who + ' has' : 'Has'} ${c.text} on ${dayText(date)}${c.note ? ` (“${c.note}”)` : ''}`;
}
export function conflictQuestion(list, date) {
  return list.length ? `${list.map((x) => conflictLine(x, date, x.who)).join('. ')}, lock anyway?` : '';
}

// The build's solver keys from this week's locks (lib/config-assemble.js):
//   locked_days [{name, day, training, trainer, note}]   every lock, roster spelling when it matches one driver
//   pairs  [{trainer, trainee, day, manual: true}]       training with a trainer the manager picked
//   autos  [{trainee, day}]                              training, the builder picks the trainer
//   unmatched [name]                                     not on this week's roster (still passed: the build says so)
export function locksForBuild(locks, weekISO, roster, aliases = {}) {
  const toRoster = (n) => matchName(n, roster, aliases).match;
  const out = { locked_days: [], pairs: [], autos: [], unmatched: [] };
  for (const l of lockList(locks, weekISO)) {
    const name = toRoster(l.driverKey);
    const day = weekday(l.date);
    const trainer = l.training && l.trainer ? toRoster(l.trainer) : null;
    if (!name) out.unmatched.push(String(l.driverKey));
    const shift = lockShift(l);
    const row = { name: name || String(l.driverKey), day, training: shift === 'route' && !!l.training,
      trainer: trainer || (l.training && l.trainer ? String(l.trainer) : null), note: String(l.note || '') };
    if (shift !== 'route') row.shift = shift;                       // the solver's default is a route
    if (shift !== 'dispatch' && l.time) row.time = String(l.time);
    if (shift === 'meeting') row.label = meetingText(l).replace(/^\S+ [AP]M /, '');
    out.locked_days.push(row);
    if (!name || !l.training || shift !== 'route') continue;
    if (l.trainer && !trainer) out.unmatched.push(String(l.trainer));   // their trainer isn't on this week: the builder picks
    if (trainer && trainer !== name) out.pairs.push({ trainer, trainee: name, day, manual: true });
    else out.autos.push({ trainee: name, day });
  }
  return out;
}

// The 🔒's hover text on a published week (read-only there).
export function lockTip(l) {
  return `${lockLine(l)}${l.training ? ` (training${l.trainer ? ' with ' + l.trainer : ''})` : ''}${
    l.by ? ' — by ' + l.by : ''}${l.note ? ` · “${l.note}”` : ''}. Locks can't be changed once the week is published.`;
}

// One line per lock the build reported (runner _lock_rows): 'ok' | 'off' (taken off by hand) | 'flag' (not placed).
export function lockState(l) {
  if (l.working) return { kind: 'ok', text: lockLine(l) };
  if (l.why) return { kind: 'flag', text: l.why === 'no route' ? 'locked, no route' : `locked, not placed — ${l.why}` };
  return { kind: 'off', text: 'locked, taken off by hand' };
}

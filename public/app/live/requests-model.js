// The Requests page (Jose 2026-10-19: it replaces the Today page) — the pure part: days off drivers
// asked for (schedule_timeoff) checked against the published Live schedule, and the VET / VTO offers
// lists. No app imports (offers-model.js has none either), so node tests/requests_test.mjs can load it.
//
// Inputs as the page's listeners hand them over:
//   offByWeek  {weekSunday: {"<day>|<name>": {name, day, note, by, at (ISO | null)}} | null (read failed) | undefined (loading)}
//   smByWeek   {weekSunday: summary (the published week's per-driver JSON, parsed) | null (not published) | undefined (loading)}
// A day off with by == 'Driver app' was asked in the drivers' app (Driver App timeoff.ts); any other by
// is the manager who typed it in (Driver preferences / this page).
import { dayLabel, timeLabel, offerWhat, offerCounts, stripStatus, dayOffers } from './offers-model.js';

export const APP_BY = 'Driver app';
export const SPAN = 14;     // "Next 14 days" / "Past 14 days"

// case- and accent-insensitive, like the Live board's search and Driver preferences
export const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

const parse = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d, 12); };
const isoOf = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
export const shiftISO = (iso, n) => { const t = parse(iso); t.setDate(t.getDate() + n); return isoOf(t); };
export const sundayOf = (iso) => shiftISO(iso, -parse(iso).getDay());

// The dates a range shows: 'next' = today and the 13 days after; 'past' = the 14 days before today.
export function rangeOf(today, range) {
  return range === 'past' ? { from: shiftISO(today, -SPAN), to: shiftISO(today, -1) }
    : { from: today, to: shiftISO(today, SPAN - 1) };
}

// The week Sundays a date span touches, earliest first.
export function weeksBetween(from, to) {
  const out = [];
  for (let w = sundayOf(from); w <= to; w = shiftISO(w, 7)) out.push(w);
  return out;
}

// Who put the day off in: {app: true, label: 'Driver app'} | {app: false, label: the manager's first name}.
export function sourceOf(t) {
  if (t && t.by === APP_BY) return { app: true, label: APP_BY };
  const first = String((t && t.by) || '').trim().split(/\s+/)[0];
  return { app: false, label: first || 'Office' };
}

// "asked Mon 3:12 PM" ('' when the time isn't known yet — a save still on its way)
export function askedLabel(at) {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? `asked ${timeLabel(ms)}` : '';
}

// A Live schedule cell in words when it puts the driver to work: "10:45 AM", "10:45 AM backup",
// "10:45 AM trainee", "10:45 AM trainer", "dispatch", "1:00 PM Meeting" — '' when it is a day off
// (blank, Unavailable, Called out, No-show, Day off). Same cell words as live-model.js cellInfo.
export function shiftWords(v) {
  const s = String(v || '').trim();
  if (!s || s === 'Unavailable' || /^(Called out|No-show|Day off)$/.test(s)) return '';
  const time = (s.match(/^\d{1,2}:\d{2} [AP]M/) || [''])[0];
  if (/meeting/i.test(s)) return s;
  if (/TRAIN helper/.test(s)) return `${time} trainer`.trim();
  if (/TRAIN drives/.test(s)) return `${time} trainee`.trim();
  if (/Backup/.test(s)) return `${time} backup`.trim();
  if (time) return time;
  if (s === 'Dispatch') return 'dispatch';
  return s;
}

// A day off against the published Live week -> {state, what}:
//   'scheduled' (what = the shift, e.g. "10:45 AM") — still on the schedule that day, not marked off
//   'off'       — off that day on the Live schedule (or not on it at all, or the station is closed)
//   'unbuilt'   — that week has no Live schedule yet: the weekly build will use the day off
//   'loading'   — the week isn't read yet
export function scheduleStatus(summary, name, date) {
  if (summary === undefined) return { state: 'loading', what: '' };
  if (!summary || !Array.isArray(summary.days)) return { state: 'unbuilt', what: '' };
  const day = summary.days.find((x) => x && x.date === date);
  if (!day) return { state: 'unbuilt', what: '' };
  if (day.open === false) return { state: 'off', what: '' };
  const f = fold(name);
  const d = (summary.drivers || []).find((x) => x && fold(x.name) === f);
  const what = d ? shiftWords((d.cells || {})[day.day]) : '';
  return what ? { state: 'scheduled', what } : { state: 'off', what: '' };
}

// Every day off in [from, to] (source: 'all' | 'app' | 'office'), each with its source and Live status:
// [{key, week, name, day, note, by, at, src, status}] by date, then name.
export function requestRows(offByWeek, smByWeek, { from, to, source = 'all' } = {}) {
  const out = [];
  for (const [week, docs] of Object.entries(offByWeek || {})) {
    const end = shiftISO(week, 6);
    for (const t of Object.values(docs || {})) {
      if (!t || !t.name || !t.day || t.day < week || t.day > end) continue;
      if ((from && t.day < from) || (to && t.day > to)) continue;
      const src = sourceOf(t);
      if ((source === 'app' && !src.app) || (source === 'office' && src.app)) continue;
      out.push({ key: `${t.day}|${t.name}`, week, name: t.name, day: t.day, note: String(t.note || '').trim(),
        by: t.by || '', at: t.at || null, src, status: scheduleStatus((smByWeek || {})[week], t.name, t.day) });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.name.localeCompare(b.name)));
}

// "this week" / "next week" / "week of Nov 2"
export function weekWord(week, today) {
  const w0 = sundayOf(today);
  if (week === w0) return 'this week';
  if (week === shiftISO(w0, 7)) return 'next week';
  return `week of ${dayLabel(week).slice(4)}`;
}

// rows -> day groups: [{date, label: 'Tue Oct 21', n, unbuilt: '' | 'next week, not built yet', rows}].
// newestFirst: the past range lists the latest day first.
export function groupByDay(rows, smByWeek, today, newestFirst = false) {
  const by = new Map();
  for (const r of rows || []) {
    if (!by.has(r.day)) by.set(r.day, []);
    by.get(r.day).push(r);
  }
  const dates = [...by.keys()].sort();
  if (newestFirst) dates.reverse();
  return dates.map((date) => {
    const week = sundayOf(date);
    const unbuilt = (smByWeek || {})[week] === null ? `${weekWord(week, today)}, not built yet` : '';
    return { date, label: dayLabel(date), n: by.get(date).length, unbuilt, rows: by.get(date) };
  });
}

// Drivers who asked off but are still on the Live schedule, from today through the next 13 days:
// {drivers: how many different drivers, groups: [{date, label, names}]} (the alert line and the nav badge).
export function conflictsOf(offByWeek, smByWeek, today) {
  const { from, to } = rangeOf(today, 'next');
  const rows = requestRows(offByWeek, smByWeek, { from, to }).filter((r) => r.status.state === 'scheduled');
  const groups = groupByDay(rows, smByWeek, today).map((g) => ({ date: g.date, label: g.label, names: g.rows.map((r) => r.name) }));
  return { drivers: new Set(rows.map((r) => fold(r.name))).size, groups };
}

// --- VET / VTO offers (schedule_offers rows as watchScheduleOffers(null) hands them over)

// {open: not closed and dated today or later (earliest first), closed: closed or past (latest first)}
export function offerLists(rows, today) {
  const open = [], closed = [];
  for (const o of rows || []) {
    if (!o) continue;
    (o.status !== 'closed' && String(o.date || '') >= today ? open : closed).push(o);
  }
  const at = (a, b) => (Number(a.at) || 0) - (Number(b.at) || 0);
  open.sort((a, b) => String(a.date).localeCompare(String(b.date)) || at(a, b));
  closed.sort((a, b) => String(b.date).localeCompare(String(a.date)) || at(a, b));
  return { open, closed };
}

// "road · 10:45 AM" / "backup · any wave" / "day off"
export function offerRole(o) {
  if (!o || o.kind !== 'vet') return offerWhat(o || {});
  return `${o.role === 'backup' ? 'backup' : 'road'} · ${o.wave || 'any wave'}`;
}

// "2 of 3 taken · open · first come" / "0 of 1 taken · open · picks at Fri 6 PM" (takes as offerCounts reads them)
export function offerLine(o, takes) {
  const c = offerCounts(o, takes);
  const st = stripStatus(o, c).word;
  const how = o.mode === 'window' ? (o.decideAt ? `picks at ${timeLabel(o.decideAt)}` : 'waits, then picks') : 'first come';
  return `${c.taken} of ${c.offered} taken · ${st} · ${how}`;
}

// A take's colour: 'ok' (approved / on the board), 'wait' (waiting / pending), 'gray' (refused / declined / other)
export function takeTone(t) {
  const s = t && t.status;
  if (s === 'approved' || s === 'applied') return 'ok';
  if (s === 'waiting' || s === 'pending') return 'wait';
  return 'gray';
}

// --- The calendar (Jose 2026-10-19: a month grid like Paycom's time-off calendar, a day panel beside it)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 'YYYY-MM' of a date; a month moved by n
export const monthOf = (iso) => String(iso).slice(0, 7);
export function shiftMonth(ym, n) {
  const [y, m] = String(ym).split('-').map(Number);
  const t = new Date(y, m - 1 + n, 1, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
}

// "Wednesday, October 14, 2026"
export function longDate(iso) {
  const t = parse(iso);
  return `${WEEKDAYS[t.getDay()]}, ${MONTHS[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}`;
}

// The month as the calendar draws it: Sunday first, always 6 rows (42 days, the days of the months
// around it greyed). -> {label: 'October 2026', weeks: [6 Sundays], cells: [{date, num, inMonth}]}
export function monthGrid(ym) {
  const first = `${ym}-01`;
  const start = sundayOf(first);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const date = shiftISO(start, i);
    return { date, num: Number(date.slice(8)), inMonth: monthOf(date) === ym };
  });
  const [y, m] = ym.split('-').map(Number);
  return { label: `${MONTHS[m - 1]} ${y}`, weeks: [0, 1, 2, 3, 4, 5].map((k) => shiftISO(start, 7 * k)), cells };
}

// The driver filter: '' = everyone; else the same name (case / accents aside), or a part of it.
export function driverMatch(name, driver) {
  const d = fold(driver);
  if (!d) return true;
  const n = fold(name);
  return n === d || n.includes(d);
}

const PENDING = new Set(['waiting', 'pending']);   // a counter is a 'pending' take too
const offerDone = (o, c) => o.status === 'closed' || o.status === 'filled' || (c.offered > 0 && c.taken >= c.offered);

// Every date in [from, to] -> {offs, offers, chips} under the filter {show: 'all'|'off'|'vet'|'vto', driver}.
// src = {offByWeek, smByWeek, offers: schedule_offers rows, takesById: {offerId: takes | undefined}}.
//   offs    the days off that date (requestRows rows, with their Live status)
//   offers  that date's offers (VET first, then by wave) — with a driver picked, only those they took
//   chips   what the calendar cell shows, one short line each ({kind, text, title = the long words}), in this
//           order: still scheduled (red), pending takes (grey), days off (orange), then one per offer:
//           VET (green) / VTO (amber) taken/spots, faded once closed or full.
// Days off have no pending state: the Driver app approves them at once (or refuses and stores nothing).
export function dayViews(from, to, src, filter = {}) {
  const show = filter.show || 'all', driver = filter.driver || '';
  const s = src || {};
  const takesOf = (o) => (s.takesById || {})[o.id];
  const out = {};
  for (let d = from; d <= to; d = shiftISO(d, 1)) out[d] = { offs: [], offers: [], chips: [] };
  if (show === 'all' || show === 'off') {
    for (const r of requestRows(s.offByWeek, s.smByWeek, { from, to })) {
      if (out[r.day] && driverMatch(r.name, driver)) out[r.day].offs.push(r);
    }
  }
  const kinds = show === 'all' ? ['vet', 'vto'] : show === 'vet' || show === 'vto' ? [show] : [];
  const byDate = {};
  for (const o of s.offers || []) {
    if (!o || !out[o.date] || !kinds.includes(o.kind === 'vto' ? 'vto' : 'vet')) continue;
    if (driver) {
      const t = takesOf(o);
      if (!Array.isArray(t) || !t.some((x) => x && driverMatch(x.name, driver))) continue;
    }
    (byDate[o.date] = byDate[o.date] || []).push(o);
  }
  for (const [date, v] of Object.entries(out)) {
    v.offers = dayOffers(byDate[date] || [], date);
    const conflicts = v.offs.filter((r) => r.status.state === 'scheduled').length;
    let pending = 0;
    for (const o of v.offers) {
      if (o.status === 'closed') continue;
      for (const t of takesOf(o) || []) if (t && PENDING.has(t.status) && driverMatch(t.name, driver)) pending++;
    }
    // one short line each (icon, count, word); title = the long words for the tooltip
    const n = v.offs.length;
    if (conflicts) v.chips.push({ kind: 'conflict', text: `⊘ ${conflicts} scheduled`,
      title: `${conflicts} driver${conflicts === 1 ? '' : 's'} asked off but ${conflicts === 1 ? 'is' : 'are'} still on the schedule` });
    if (pending) v.chips.push({ kind: 'pending', text: `⏱ ${pending} pending`,
      title: `${pending} VET / VTO take${pending === 1 ? '' : 's'} waiting for an answer` });
    if (n) v.chips.push({ kind: 'off', text: `✓ ${n} off`, title: `${n} driver${n === 1 ? '' : 's'} asked for the day off` });
    for (const k of ['vet', 'vto']) {
      for (const o of v.offers.filter((x) => (x.kind === 'vto' ? 'vto' : 'vet') === k)) {
        const c = offerCounts(o, takesOf(o));
        v.chips.push({ kind: k, text: `${k.toUpperCase()} ${c.taken}/${c.offered}`, faded: offerDone(o, c), id: o.id,
          title: `${k.toUpperCase()} · ${offerRole(o)} · ${offerLine(o, takesOf(o))}` });
      }
    }
  }
  return out;
}

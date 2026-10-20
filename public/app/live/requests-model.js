// The Requests page (Jose 2026-10-19: it replaces the Today page) — the pure part: days off drivers
// asked for (schedule_timeoff) checked against the published Live schedule, and the VET / VTO offers
// lists. Imports only plain-node modules (offers-model.js, lib/driver-prefs.js's pure helpers), so node
// tests/requests_test.mjs can load it.
//
// Inputs as the page's listeners hand them over:
//   offByWeek  {weekSunday: {"<day>|<name>": {name, day, note, by, at (ISO | null)}} | null (read failed) | undefined (loading)}
//   smByWeek   {weekSunday: summary (the published week's per-driver JSON, parsed) | null (not published) | undefined (loading)}
//   blocked    {day: {day, week, reason, by, at}} — days closed to drivers' requests (blackout, 2026-10-19)
//   prefs      the Driver preferences doc {v, drivers: {name: Pref}} + activeNames (the active roster) — only
//              read with filter.unavail ("Show everyone's unavailable days", 2026-10-19)
// A day off with by == 'Driver app' was asked in the drivers' app (Driver App timeoff.ts); any other by
// is the manager who typed it in (Driver preferences / this page).
import { dayLabel, timeLabel, offerWhat, offerCounts, stripStatus, dayOffers } from './offers-model.js';
import { normPref, prefOffDays } from '../lib/driver-prefs.js';

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

// "asked Mon 3:12 PM" ('' when the time isn't known yet — a save still on its way). at = ISO or ms.
export function askedLabel(at) {
  const ms = typeof at === 'number' ? (at > 0 ? at : NaN) : at ? Date.parse(at) : NaN;
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
// reviews (optional): an approved day-off review whose day didn't go on the schedule counts too.
export function conflictsOf(offByWeek, smByWeek, today, reviews) {
  const { from, to } = rangeOf(today, 'next');
  const rows = requestRows(offByWeek, smByWeek, { from, to });
  const have = new Set(rows.map((r) => `${r.day}|${fold(r.name)}`));
  for (const r of reviews || []) {
    if (!r || r.status !== 'approved' || !r.day || r.day < from || r.day > to || have.has(`${r.day}|${fold(r.name)}`)) continue;
    have.add(`${r.day}|${fold(r.name)}`);
    rows.push({ name: r.name, day: r.day, status: scheduleStatus((smByWeek || {})[r.week || sundayOf(r.day)], r.name, r.day) });
  }
  rows.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.name.localeCompare(y.name)));
  const hit = rows.filter((r) => r.status.state === 'scheduled');
  const groups = groupByDay(hit, smByWeek, today).map((g) => ({ date: g.date, label: g.label, names: g.rows.map((r) => r.name) }));
  return { drivers: new Set(hit.map((r) => fold(r.name))).size, groups };
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

// --- Day-off reviews (Driver App SPEC-v4, Jose 2026-10-19): a day off the Driver app refused (the day was
// full, or requests closed) that the driver sent for review. timeoff_reviews rows as jajb.js
// watchTimeoffReviews hands them over: {id, tid, name, week, day, note, refused: full|closed,
// status: pending|approved|denied|cancelled, at (ms), decidedBy?, decidedAt?, why?, appliedAt?,
// applyResult? {ok, how: timeoff|none, text}}. Cancelled ones are never shown.
// Once the review's WEEK IS PUBLISHED it can't be approved (Jose 2026-10-19: missing a day then is a call-off):
// the rules refuse it, the server closes pending ones on publish; the page offers only "Close it" (= deny with
// CALL_OFF_WHY, the same words the server uses).

const REFUSED = { full: 'the day was full', closed: 'requests were closed for that week' };
export const refusedText = (r) => REFUSED[r && r.refused] || 'the app said no';

// what the driver reads when a review is closed because its week is published (= hub schedule_reviews.BLOCK_WHY)
export const CALL_OFF_WHY = "The schedule for that week is already out. To miss a day you're scheduled, call off.";
export const PUBLISHED_NOTE = "Week already published — it's a call-off now";

// Is this week on the Live schedule? smByWeek[week]: summary (yes) | null (not published) | undefined (loading:
// treated as not known yet -> false; the rules still refuse an approval of a published week).
export const weekPublished = (smByWeek, week) => {
  const s = (smByWeek || {})[week];
  return !!s && typeof s === 'object';
};

// What a waiting review offers: {approve, deny, close, note}. Week published -> only "Close it" (deny with
// CALL_OFF_WHY) and the note; else Approve / Deny… (a reason the manager writes).
export function reviewActions(r) {
  if (r && r.published) return { approve: false, deny: false, close: true, note: PUBLISHED_NOTE };
  return { approve: true, deny: true, close: false, note: '' };
}

// The ones still to answer (from a day on, '' = every day), by day then sent time.
export function pendingReviews(reviews, from = '') {
  return (reviews || []).filter((r) => r && r.status === 'pending' && r.day && String(r.day) >= from)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)) || (Number(a.at) || 0) - (Number(b.at) || 0));
}

// The alert's second line: {n, groups: [{date, label, names}]} of the reviews waiting, from today on.
export function reviewsWaiting(reviews, today) {
  const rows = pendingReviews(reviews, today);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.day)) by.set(r.day, []); by.get(r.day).push(r.name); }
  return { n: rows.length, groups: [...by.entries()].map(([date, names]) => ({ date, label: dayLabel(date), names })) };
}

// The red line under a day off approved from a review that couldn't go on the schedule ('' = fine / not yet).
export function applyProblem(r) {
  const a = r && r.applyResult;
  if (!a || a.ok !== false) return '';
  return `Couldn't put it on the schedule: ${String(a.text || '').replace(/[.\s]+$/, '')} — fix it on the Live schedule`;
}

// A deny reason: one line, required, at most 200 characters -> {why} | {error}
export function denyReason(text) {
  const why = String(text || '').replace(/\s+/g, ' ').trim();
  if (!why) return { error: 'Write the reason — the driver sees it.' };
  if (why.length > 200) return { error: 'Keep the reason to 200 characters.' };
  return { why };
}

// --- Blocked days ("blackout", Jose 2026-10-19): days managers closed to drivers' day-off requests
// (schedule_blocked_days). The Drivers app refuses a request or a review for them; days off already on file
// stay, and a manager can still add one by hand (a one-line warning, no hard stop).
export const BLOCKED_WARN = "This day is blocked — drivers can't ask for it. You can still add a day off by hand.";
export const BLOCK_REASON_MAX = 120;
// An optional block reason (managers only): one line, at most 120 characters -> {reason} | {error}
export function blockReason(text) {
  const reason = String(text || '').replace(/\s+/g, ' ').trim();
  if (reason.length > BLOCK_REASON_MAX) return { error: `Keep the reason to ${BLOCK_REASON_MAX} characters.` };
  return { reason };
}
// The blocked entry of a day, or null ({day: entry} map | null | undefined).
export const blockedOf = (blocked, date) => {
  const b = (blocked || {})[date];
  return b && typeof b === 'object' ? b : null;
};

// --- Standing unavailability ("Show everyone's unavailable days", Jose 2026-10-19): who can't work a day
// because of their Driver preferences (the same rule the build reads: prefOffDays), active roster only.
const FULL_DAY = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The rule in plain words, for a day they can't work: why 'days' (the days they can work) or 'weekend'
// (every other weekend, this one off).
export function unavailRule(pref, why) {
  if (why === 'weekend') return 'every other weekend — this one is off';
  const p = normPref(pref);
  const can = (p && p.days) || WEEK;
  const missing = WEEK.filter((d) => !can.includes(d));
  if (!missing.length) return "can't work this day";
  if (missing.length === 1) return `never works ${FULL_DAY[missing[0]]}s`;
  const idx = missing.map((d) => WEEK.indexOf(d));
  const run = idx[idx.length - 1] - idx[0] + 1 === idx.length;
  if (can.length === 1) return `only works ${FULL_DAY[can[0]]}s`;
  return run ? `not available ${missing[0]}–${missing[missing.length - 1]}` : `not available ${missing.join(', ')}`;
}
// [{name, why, rule}] of the active drivers their preferences keep off `date`, by name. prefsDoc = {drivers};
// activeNames = the active roster (folded match; null/undefined = everyone in the prefs).
export function standingUnavailable(prefsDoc, activeNames, date) {
  const active = Array.isArray(activeNames) ? new Set(activeNames.map(fold)) : null;
  const day = WEEK[parse(date).getDay()];
  const out = [];
  for (const [name, pref] of Object.entries((prefsDoc && prefsDoc.drivers) || {})) {
    if (active && !active.has(fold(name))) continue;
    const why = prefOffDays(pref, sundayOf(date))[day];
    if (why) out.push({ name, why, rule: unavailRule(pref, why) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// What a Live cell says about someone NOT working that day ('' = they work: any shift, Dispatch, meeting…).
const LIVE_OFF = { '': 'not scheduled', Unavailable: 'Unavailable', 'Day off': 'Day off', 'Called out': 'Called out', 'No-show': 'No-show' };
const MARK_WORDS = { off: 'Day off', callout: 'Called out', noshow: 'No-show' };

// Everyone off one day, each driver ONCE (Jose 2026-10-19: "how many people are already off that day", to
// decide whether to block it), in this priority:
//   asked     names with a day off on file that day (the view's offs: requests + approved reviews)
//   standing  [{name, why, rule}] their Driver preferences keep them off (active roster)
//   live      [{name, what}] off on the published Live week: active drivers with a blank / Unavailable /
//             Day off cell, marked off / called out / no-show, or not on that week at all
// liveState 'published' | 'closed' (no routes that day) | 'unbuilt' (week not published yet) | 'loading';
// working = drivers on the Live week with a shift that day (null unless published); total = all three lists.
// offNames = the day's days-off names; activeNames = the active roster (null = the prefs' / week's names);
// driver = the page's driver filter.
export function everyoneOff(offNames, summary, prefsDoc, activeNames, date, driver = '') {
  const seen = new Set();
  const once = (name) => { const f = fold(name); if (!f || seen.has(f)) return false; seen.add(f); return true; };
  const asked = (offNames || []).filter((n) => driverMatch(n, driver) && once(n));
  const standing = standingUnavailable(prefsDoc, activeNames, date).filter((u) => driverMatch(u.name, driver) && once(u.name));
  const out = { asked, standing, live: [], liveState: 'loading', working: null, total: 0 };
  if (summary === undefined) out.liveState = 'loading';
  else if (!summary || !Array.isArray(summary.days) || !summary.days.some((x) => x && x.date === date)) out.liveState = 'unbuilt';
  else {
    const di = summary.days.find((x) => x && x.date === date);
    const rows = new Map((summary.drivers || []).filter((d) => d && d.name).map((d) => [fold(d.name), d]));
    const marks = new Map((summary.marks || []).filter((m) => m && m.day === di.day).map((m) => [fold(m.name), m]));
    const people = Array.isArray(activeNames) ? activeNames : [...rows.values()].map((d) => d.name);
    out.liveState = di.open === false ? 'closed' : 'published';
    out.working = 0;
    for (const name of [...new Set(people)].sort((a, b) => a.localeCompare(b))) {
      const row = rows.get(fold(name));
      const mark = marks.get(fold(name));
      const cell = row ? String((row.cells || {})[di.day] || '').trim() : null;
      let what = '';
      if (di.open === false) what = 'no routes this day';
      else if (!row) what = 'not on this week';
      else if (mark) what = MARK_WORDS[mark.kind] || 'marked off';
      else if (cell in LIVE_OFF) what = LIVE_OFF[cell];
      if (!what) { if (driverMatch(name, driver)) out.working++; continue; }
      if (driverMatch(name, driver) && once(name)) out.live.push({ name, what });
    }
  }
  out.total = asked.length + standing.length + out.live.length;
  return out;
}

// The calendar chip's tooltip: "21 drivers off: 4 asked off, 9 standing preferences, 8 off on the Live schedule".
export function everyoneTitle(e) {
  const liveWords = e.liveState === 'published' || e.liveState === 'closed' ? `${e.live.length} off on the Live schedule`
    : e.liveState === 'unbuilt' ? 'week not published yet' : 'Live schedule loading';
  return `${e.total} driver${e.total === 1 ? '' : 's'} off: ${e.asked.length} asked off, ${e.standing.length} standing preferences, ${liveWords}`;
}

// "Working: 58 · Off: 21" (the Live week's count of drivers with a shift that day), or "Off: 21" without it.
export function workingLine(e) {
  return e.working == null ? `Off: ${e.total}` : `Working: ${e.working} · Off: ${e.total}`;
}

// Every date in [from, to] -> {waiting, offs, denied, offers, chips} under the filter
// {show: 'all'|'off'|'vet'|'vto', driver, unavail} ("Days off" includes the reviews and, with unavail, the
// standing unavailability; VET / VTO don't).
// src = {offByWeek, smByWeek, offers: schedule_offers rows, takesById: {offerId: takes | undefined}, reviews,
//        blocked: {day: entry}, prefs: Driver preferences doc, activeNames: the active roster's names}.
//   blocked  the day's blocked entry ({reason, by, at}) or null — whatever the filter
//   everyone with filter.unavail ("Show everyone's unavailable days"): everyoneOff() — everyone off that day,
//            each once (asked off > standing preferences > off on the Live week) + working; else null
//   waiting the day-off reviews still to answer that date (+ live: their Live status, as for offs; published:
//           their week is on the Live schedule -> only "Close it", see reviewActions)
//   offs    the days off that date (requestRows rows, with their Live status); an approved review adds
//           approvedBy / review to the same driver's day off, or is a row of its own (fromReview: the Live
//           week was marked instead, or not yet — no schedule_timeoff doc, so nothing to remove)
//   denied  the reviews answered no that date (the "Answered" list)
//   offers  that date's offers (VET first, then by wave) — with a driver picked, only those they took
//   chips   what the calendar cell shows, one short line each ({kind, text, title = the long words}), in this
//           order: blocked (dark), still scheduled (red), waiting (grey: day-off reviews + VET / VTO takes), days
//           off (orange), "N off in all" (blue-grey, with filter.unavail), then one per offer:
//           VET (green) / VTO (amber) taken/spots, faded once closed or full.
// A day off itself has no pending state (the Driver app approves it at once); only a review waits.
export function dayViews(from, to, src, filter = {}) {
  const show = filter.show || 'all', driver = filter.driver || '';
  const s = src || {};
  const takesOf = (o) => (s.takesById || {})[o.id];
  const out = {};
  for (let d = from; d <= to; d = shiftISO(d, 1)) {
    out[d] = { waiting: [], offs: [], denied: [], offers: [], chips: [], blocked: blockedOf(s.blocked, d), everyone: null };
  }
  if (show === 'all' || show === 'off') {
    for (const r of requestRows(s.offByWeek, s.smByWeek, { from, to })) {
      if (out[r.day] && driverMatch(r.name, driver)) out[r.day].offs.push(r);
    }
    for (const r of s.reviews || []) {
      if (!r || !out[r.day] || !driverMatch(r.name, driver)) continue;
      const v = out[r.day];
      const week = r.week || sundayOf(r.day);
      const live = scheduleStatus((s.smByWeek || {})[week], r.name, r.day);
      if (r.status === 'pending') v.waiting.push({ ...r, live, published: weekPublished(s.smByWeek, week) });
      else if (r.status === 'denied') v.denied.push(r);
      else if (r.status === 'approved') {
        const same = v.offs.find((x) => fold(x.name) === fold(r.name));
        if (same) { same.approvedBy = r.decidedBy || ''; same.review = r; continue; }
        v.offs.push({ key: `${r.day}|${r.name}|review`, week, name: r.name, day: r.day, note: String(r.note || '').trim(),
          by: APP_BY, at: r.at || null, src: sourceOf({ by: APP_BY }), status: live,
          approvedBy: r.decidedBy || '', review: r, fromReview: true });
      }
    }
    const byAt = (a, b) => (Number(a.at) || 0) - (Number(b.at) || 0);
    for (const v of Object.values(out)) {
      v.waiting.sort(byAt); v.denied.sort(byAt);
      v.offs.sort((a, b) => a.name.localeCompare(b.name));
    }
    // everyone off that day, each once (asked off > Driver preferences > the Live week): the offs are already
    // driver-filtered; everyoneOff filters the rest
    if (filter.unavail) {
      for (const [date, v] of Object.entries(out)) {
        v.everyone = everyoneOff(v.offs.map((r) => r.name), (s.smByWeek || {})[sundayOf(date)], s.prefs, s.activeNames, date, driver);
      }
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
    let takesWaiting = 0;
    for (const o of v.offers) {
      if (o.status === 'closed') continue;
      for (const t of takesOf(o) || []) if (t && PENDING.has(t.status) && driverMatch(t.name, driver)) takesWaiting++;
    }
    const reviewsW = v.waiting.length;
    const pending = takesWaiting + reviewsW;
    const waitWords = [reviewsW ? `${reviewsW} day-off review${reviewsW === 1 ? '' : 's'}` : '',
      takesWaiting ? `${takesWaiting} VET / VTO take${takesWaiting === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    // one short line each (icon, count, word); title = the long words for the tooltip
    const n = v.offs.length;
    if (v.blocked) v.chips.push({ kind: 'blocked', text: '⛔ Blocked',
      title: `Blocked — no day-off requests from the drivers' app${v.blocked.reason ? ` (${v.blocked.reason})` : ''}` });
    if (conflicts) v.chips.push({ kind: 'conflict', text: `⊘ ${conflicts} sched`,
      title: `${conflicts} driver${conflicts === 1 ? '' : 's'} asked off but ${conflicts === 1 ? 'is' : 'are'} still on the schedule` });
    if (pending) v.chips.push({ kind: 'pending', text: `⏱ ${pending} wait`,
      title: `${waitWords} waiting for an answer` });
    if (n) v.chips.push({ kind: 'off', text: `✓ ${n} off`, title: `${n} driver${n === 1 ? '' : 's'} asked for the day off` });
    if (v.everyone && v.everyone.total) v.chips.push({ kind: 'alloff', text: `${v.everyone.total} off in all`, title: everyoneTitle(v.everyone) });
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

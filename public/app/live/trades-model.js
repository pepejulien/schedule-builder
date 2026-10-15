// Driver trades (Driver App SPEC-v3, 2026-10-15): the pure part of the Live board's read-only Trades
// strip (live/trades.js) — which trades the shown week / days get and the words each row shows.
// Drivers give away or swap shifts in the Driver App; the hub puts agreed deals on the board by itself
// (no manager action — Jose 2026-10-15). No app imports, so node tests/trades_test.mjs can load it.
//
// driver_trades/{id} as jajb.js watchDriverTrades hands it over: {id, v, giver: {tid, name}, week, date, day,
// role: road|backup, wave ('10:45 AM' | '' = plain backup), swapDays [ISO], status: open|agreed|applied|
// refused|closed|cancelled, deal?: {kind: give|swap|backup, taker: {tid, name}, date?, week?, role?, wave?}
// (date/week/role/wave: the taker's shift in a swap), at, deadline, agreedAt?, appliedAt?, refusedAt?,
// closedAt?, cancelledAt? (all ms), why?}. props/{tid}: {tid, name, date, role, wave, at (ms), status:
// pending|accepted|declined, why?}.
import { dayLabel, timeLabel } from './offers-model.js';

export { dayLabel, timeLabel };

// "10:45 AM route" / "route" / "10:45 AM backup" / "backup"
export function shiftWhat(role, wave) {
  const r = role === 'backup' ? 'backup' : 'route';
  return wave ? `${wave} ${r}` : r;
}

// "Thu Oct 22 · 10:45 AM route"
export const shiftLabel = (date, role, wave) => `${dayLabel(date)} · ${shiftWhat(role, wave)}`;

// The deal's kind in words; a post nobody has taken yet is "Offered".
const KINDS = { give: 'Giveaway', swap: 'Trade', backup: 'Added as Backup' };
export const kindLabel = (t) => (t && t.deal && KINDS[t.deal.kind]) || 'Offered';

const nameOf = (p) => (p && (p.name || p.tid)) || '—';

// Who gives the shift to whom: "Ana Smith → Bob Jones" / "Ana Smith ⇄ Bob Jones" (a trade) / "Ana Smith" (no taker).
export function whoLabel(t) {
  const g = nameOf(t && t.giver);
  const tk = t && t.deal && t.deal.taker;
  if (!tk) return g;
  return `${g} ${t.deal.kind === 'swap' ? '⇄' : '→'} ${nameOf(tk)}`;
}

// The day(s) and shift(s): the giver's shift, and in a trade the taker's shift that goes back to the giver.
// -> ['Thu Oct 22 · 10:45 AM route (Ana Smith)', 'Tue Oct 20 · 11:05 AM route (Bob Jones)'] for a trade,
//    ['Thu Oct 22 · 10:45 AM route'] otherwise (the taker of a "Added as Backup" deal works it as a backup).
export function shiftLines(t) {
  const giverShift = shiftLabel(t.date, t.role, t.wave);
  const d = t.deal;
  if (d && d.kind === 'swap' && d.date) {
    return [`${giverShift} (${nameOf(t.giver)})`, `${shiftLabel(d.date, d.role, d.wave)} (${nameOf(d.taker)})`];
  }
  return [giverShift];
}

// the hub's refusal codes (SPEC-v3 §4a) in plain words; anything else is shown as it came
const WHY = {
  limits: 'over the hour limits', blocked: 'a schedule rule blocks it', unavail: 'asked for that day off',
  no_shift: "the shift wasn't on the schedule any more", changed: 'the schedule changed', error: 'the save failed',
};
export const tradeWhy = (why) => (why ? (WHY[why] || String(why)) : '');

// The status: {word, chip, label, reason, time}: label = the chip's words (open posts: until when they can
// be taken — 6 PM New York the day before, the post's deadline), reason = why the hub refused it ('' else),
// time = when the status happened (ms, 0 = none).
export function tradeStatus(t) {
  const st = (word, chip, time, label = word, reason = '') => ({ word, chip, label, reason, time: Number(time) || 0 });
  switch (t && t.status) {
    case 'open': return st('Open', 'green', t.at, t.deadline ? `Open until ${timeLabel(t.deadline)}` : 'Open');
    case 'agreed': return st('Agreed', 'blue', t.agreedAt || t.at);
    case 'applied': return st('Applied', 'green', t.appliedAt || t.agreedAt);
    case 'refused': return st('Refused', 'lock', t.refusedAt || t.agreedAt, 'Refused', tradeWhy(t.why));
    case 'closed': return st('Closed', 'gray', t.closedAt || t.deadline);
    case 'cancelled': return st('Cancelled', 'gray', t.cancelledAt);
    default: return st(String((t && t.status) || ''), 'gray', t && t.at);
  }
}

// What happened when, oldest first, for the open row: [{label, ms}] — e.g. Posted, Agreed, Applied.
export function tradeEvents(t) {
  const ev = [['Posted', t.at], ['Agreed', t.agreedAt], ['Applied', t.appliedAt], ['Refused', t.refusedAt],
    ['Closed', t.closedAt], ['Cancelled by the driver', t.cancelledAt]];
  return ev.filter(([, ms]) => Number(ms) > 0).map(([label, ms]) => ({ label, ms: Number(ms) }));
}

// The trades the strip shows: those with a day in the shown week (the post's own day, or a trade's other
// day), only the picked dates when dates is a list; by the earliest such day, then posted time.
// rows = watchDriverTrades rows; weekDates = the shown week's 7 dates.
export function tradesInScope(rows, weekDates, dates) {
  const week = new Set(weekDates || []);
  const pick = Array.isArray(dates) && dates.length ? new Set(dates) : null;
  const daysOf = (t) => [t.date, t.deal && t.deal.kind === 'swap' ? t.deal.date : null].filter(Boolean);
  const keep = (d) => week.has(d) && (!pick || pick.has(d));
  return (rows || []).filter((t) => t && daysOf(t).some(keep))
    .map((t) => ({ t, first: daysOf(t).filter(keep).sort()[0] }))
    .sort((a, b) => a.first.localeCompare(b.first) || (Number(a.t.at) || 0) - (Number(b.t.at) || 0))
    .map((x) => x.t);
}

// The giver's exchange days: "Would work instead: Tue Oct 20, Wed Oct 21" ('' when none).
export const swapDaysLabel = (t) => ((t && t.swapDays) || []).length
  ? `Would work instead: ${t.swapDays.slice().sort().map(dayLabel).join(', ')}` : '';

// A proposal in words: "Bob Jones offered Tue Oct 20 · 11:05 AM route — waiting for an answer"
const PROP = { pending: 'waiting for an answer', accepted: 'accepted', declined: 'declined' };
export function propLabel(p) {
  return `${nameOf(p)} offered ${shiftLabel(p.date, p.role, p.wave)} — ${PROP[p.status] || String(p.status || '')}`;
}

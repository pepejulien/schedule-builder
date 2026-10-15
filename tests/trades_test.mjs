// Drivers' trades strip helpers (public/app/live/trades-model.js, Driver App SPEC-v3, PLAN task 36): which
// trades the shown week / days get, and the row words (kind, who, shifts, status, refusal reasons).
//   node tests/trades_test.mjs
import {
  shiftWhat, shiftLabel, kindLabel, whoLabel, shiftLines, tradeWhy, tradeStatus, tradeEvents, tradesInScope, swapDaysLabel, propLabel,
} from '../public/app/live/trades-model.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

const ms = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();   // Oct d, h:m on this computer's clock
const giver = { tid: 'T1', name: 'Ana Smith' };
const taker = { tid: 'T2', name: 'Bob Jones' };
const post = (p) => ({ id: 'x', v: 1, giver, week: '2026-10-18', date: '2026-10-22', day: 'Thu', role: 'road', wave: '10:45 AM',
  swapDays: [], status: 'open', at: ms(19, 14), deadline: ms(21, 18), ...p });

// --- shifts
eq('shiftWhat', [shiftWhat('road', '10:45 AM'), shiftWhat('road', ''), shiftWhat('backup', '11:05 AM'), shiftWhat('backup', '')],
  ['10:45 AM route', 'route', '11:05 AM backup', 'backup']);
eq('shiftLabel', shiftLabel('2026-10-22', 'road', '10:45 AM'), 'Thu Oct 22 · 10:45 AM route');

// --- kind and who
eq('kind: open post', kindLabel(post()), 'Offered');
eq('kind: give / swap / backup', ['give', 'swap', 'backup'].map((kind) => kindLabel(post({ deal: { kind, taker } }))),
  ['Giveaway', 'Trade', 'Added as Backup']);
eq('who: no taker', whoLabel(post()), 'Ana Smith');
eq('who: giveaway', whoLabel(post({ deal: { kind: 'give', taker } })), 'Ana Smith → Bob Jones');
eq('who: backup', whoLabel(post({ deal: { kind: 'backup', taker } })), 'Ana Smith → Bob Jones');
eq('who: trade', whoLabel(post({ deal: { kind: 'swap', taker } })), 'Ana Smith ⇄ Bob Jones');
eq('who: name missing -> tid', whoLabel(post({ giver: { tid: 'T1' }, deal: { kind: 'give', taker: { tid: 'T2' } } })), 'T1 → T2');

// --- shift lines
eq('lines: giveaway', shiftLines(post({ deal: { kind: 'give', taker } })), ['Thu Oct 22 · 10:45 AM route']);
eq('lines: plain backup', shiftLines(post({ role: 'backup', wave: '' })), ['Thu Oct 22 · backup']);
eq('lines: trade', shiftLines(post({ deal: { kind: 'swap', taker, date: '2026-10-20', week: '2026-10-18', role: 'road', wave: '11:05 AM' } })),
  ['Thu Oct 22 · 10:45 AM route (Ana Smith)', 'Tue Oct 20 · 11:05 AM route (Bob Jones)']);

// --- status
eq('open: until the deadline', tradeStatus(post()), { word: 'Open', chip: 'green', label: 'Open until Wed 6 PM', reason: '', time: ms(19, 14) });
eq('open: no deadline', tradeStatus(post({ deadline: 0 })).label, 'Open');
eq('agreed', tradeStatus(post({ status: 'agreed', agreedAt: ms(20, 9) })), { word: 'Agreed', chip: 'blue', label: 'Agreed', reason: '', time: ms(20, 9) });
eq('applied', tradeStatus(post({ status: 'applied', agreedAt: ms(20, 9), appliedAt: ms(20, 9, 1) })),
  { word: 'Applied', chip: 'green', label: 'Applied', reason: '', time: ms(20, 9, 1) });
eq('refused + reason', tradeStatus(post({ status: 'refused', why: 'limits', refusedAt: ms(20, 9, 2) })),
  { word: 'Refused', chip: 'lock', label: 'Refused', reason: 'over the hour limits', time: ms(20, 9, 2) });
eq('refused reasons', ['limits', 'blocked', 'unavail', 'no_shift', 'changed', 'error', 'odd', ''].map(tradeWhy),
  ['over the hour limits', 'a schedule rule blocks it', 'asked for that day off', "the shift wasn't on the schedule any more",
    'the schedule changed', 'the save failed', 'odd', '']);
eq('closed: at the deadline', tradeStatus(post({ status: 'closed' })).time, ms(21, 18));
eq('cancelled', tradeStatus(post({ status: 'cancelled', cancelledAt: ms(20, 8) })), { word: 'Cancelled', chip: 'gray', label: 'Cancelled', reason: '', time: ms(20, 8) });

// --- events
eq('events', tradeEvents(post({ status: 'applied', agreedAt: ms(20, 9), appliedAt: ms(20, 9, 1) })).map((e) => e.label),
  ['Posted', 'Agreed', 'Applied']);
eq('events: cancelled', tradeEvents(post({ status: 'cancelled', cancelledAt: ms(20, 8) })).map((e) => e.label),
  ['Posted', 'Cancelled by the driver']);

// --- scope: the shown week, the picked days; a trade's other day counts
const week = ['18', '19', '20', '21', '22', '23', '24'].map((d) => `2026-10-${d}`);
const rows = [
  post({ id: 'a', date: '2026-10-23', at: 5 }),
  post({ id: 'b', date: '2026-10-22', at: 9 }),
  post({ id: 'c', date: '2026-10-22', at: 2 }),
  post({ id: 'd', date: '2026-10-16', week: '2026-10-11', status: 'applied',     // last week's day traded for this Tue
    deal: { kind: 'swap', taker, date: '2026-10-20', week: '2026-10-18', role: 'road', wave: '' } }),
  post({ id: 'e', date: '2026-10-27', week: '2026-10-25' }),                   // next week: out
  post({ id: 'f', date: '2026-10-14', week: '2026-10-11', deal: { kind: 'give', taker } }),   // not a swap: out
  null,
];
eq('scope: week', tradesInScope(rows, week, null).map((t) => t.id), ['d', 'c', 'b', 'a']);
eq('scope: one day', tradesInScope(rows, week, ['2026-10-22']).map((t) => t.id), ['c', 'b']);
eq('scope: other day of a trade', tradesInScope(rows, week, ['2026-10-20']).map((t) => t.id), ['d']);
eq('scope: several days', tradesInScope(rows, week, ['2026-10-23', '2026-10-20']).map((t) => t.id), ['d', 'a']);
eq('scope: empty pick = week', tradesInScope(rows, week, []).length, 4);
eq('scope: none', [tradesInScope(null, week), tradesInScope(rows, [], null)], [[], []]);

// --- exchange days and proposals
eq('swapDays', swapDaysLabel(post({ swapDays: ['2026-10-21', '2026-10-20'] })), 'Would work instead: Tue Oct 20, Wed Oct 21');
eq('swapDays none', [swapDaysLabel(post()), swapDaysLabel({})], ['', '']);
eq('prop', propLabel({ tid: 'T2', name: 'Bob Jones', date: '2026-10-20', role: 'road', wave: '11:05 AM', status: 'pending' }),
  'Bob Jones offered Tue Oct 20 · 11:05 AM route — waiting for an answer');
eq('prop declined', propLabel({ tid: 'T3', date: '2026-10-21', role: 'backup', wave: '', status: 'declined' }),
  'T3 offered Wed Oct 21 · backup — declined');

console.log(`${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('FAIL ' + f); process.exit(1); }

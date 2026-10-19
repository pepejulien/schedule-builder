// Requests page helpers (public/app/live/requests-model.js): days off vs the Live schedule, the
// day groups, the conflicts alert / nav badge, and the VET / VTO lists.   node tests/requests_test.mjs
import {
  APP_BY, fold, shiftISO, sundayOf, rangeOf, weeksBetween, sourceOf, askedLabel, shiftWords, scheduleStatus,
  requestRows, weekWord, groupByDay, conflictsOf, offerLists, offerRole, offerLine, takeTone,
} from '../public/app/live/requests-model.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// --- dates
const T = '2026-10-19';                       // a Monday
eq('sundayOf', [sundayOf(T), sundayOf('2026-10-18'), sundayOf('2026-10-24')], ['2026-10-18', '2026-10-18', '2026-10-18']);
eq('shiftISO across a month', shiftISO('2026-10-30', 3), '2026-11-02');
eq('rangeOf next', rangeOf(T, 'next'), { from: '2026-10-19', to: '2026-11-01' });
eq('rangeOf past', rangeOf(T, 'past'), { from: '2026-10-05', to: '2026-10-18' });
eq('weeksBetween next', weeksBetween('2026-10-19', '2026-11-01'), ['2026-10-18', '2026-10-25', '2026-11-01']);
eq('weeksBetween one week', weeksBetween('2026-10-18', '2026-10-24'), ['2026-10-18']);

// --- source / asked
eq('source app', sourceOf({ by: APP_BY }), { app: true, label: 'Driver app' });
eq('source manager first name', sourceOf({ by: 'Jose A Julien' }), { app: false, label: 'Jose' });
eq('source unknown', sourceOf({ by: '' }), { app: false, label: 'Office' });
eq('asked label', askedLabel(new Date(2026, 9, 19, 15, 12).toISOString()), 'asked Mon 3:12 PM');
eq('asked label none', [askedLabel(null), askedLabel('nope')], ['', '']);
eq('fold', fold(' José  '), 'jose');

// --- cells
eq('shiftWords', ['10:45 AM', '10:25 AM Backup', '10:45 AM TRAIN drives (w/ Cara)', '10:45 AM TRAIN helper (w/ Dan)', 'Dispatch', '1:00 PM Meeting'].map(shiftWords),
  ['10:45 AM', '10:25 AM backup', '10:45 AM trainee', '10:45 AM trainer', 'dispatch', '1:00 PM Meeting']);
eq('shiftWords off', ['', 'Unavailable', 'Called out', 'No-show', 'Day off'].map(shiftWords), ['', '', '', '', '']);

// a published week (2026-10-18) with Tue closed on purpose for one test
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const week = (sun, cellsBy, closed = []) => ({
  days: DAYS.map((d, i) => ({ day: d, date: shiftISO(sun, i), open: !closed.includes(d) })),
  drivers: Object.entries(cellsBy).map(([name, cells]) => ({ name, cells })),
});
const SM = week('2026-10-18', {
  'Jason Leidy': { Tue: '10:45 AM', Wed: 'Called out' },
  'Ana Road': { Tue: '10:25 AM Backup', Thu: 'Unavailable' },
  'Zoé Ñame': { Fri: 'Dispatch' },
}, ['Sat']);

eq('status scheduled', scheduleStatus(SM, 'Jason Leidy', '2026-10-20'), { state: 'scheduled', what: '10:45 AM' });
eq('status backup', scheduleStatus(SM, 'ana road', '2026-10-20'), { state: 'scheduled', what: '10:25 AM backup' });
eq('status marked off', scheduleStatus(SM, 'Jason Leidy', '2026-10-21'), { state: 'off', what: '' });
eq('status unavailable', scheduleStatus(SM, 'Ana Road', '2026-10-22'), { state: 'off', what: '' });
eq('status blank day', scheduleStatus(SM, 'Jason Leidy', '2026-10-22'), { state: 'off', what: '' });
eq('status not on the schedule', scheduleStatus(SM, 'Nobody Here', '2026-10-20'), { state: 'off', what: '' });
eq('status station closed', scheduleStatus(SM, 'Jason Leidy', '2026-10-24'), { state: 'off', what: '' });
eq('status accent-insensitive', scheduleStatus(SM, 'Zoe Name', '2026-10-23'), { state: 'scheduled', what: 'dispatch' });
eq('status unbuilt', scheduleStatus(null, 'Jason Leidy', '2026-10-27'), { state: 'unbuilt', what: '' });
eq('status loading', scheduleStatus(undefined, 'Jason Leidy', '2026-10-27'), { state: 'loading', what: '' });

// --- rows / groups / conflicts
const at = new Date(2026, 9, 17, 9, 0).toISOString();
const OFF = {
  '2026-10-18': {
    '2026-10-20|Jason Leidy': { name: 'Jason Leidy', day: '2026-10-20', note: 'court', by: APP_BY, at },
    '2026-10-20|Ana Road': { name: 'Ana Road', day: '2026-10-20', note: '', by: 'Maria Lopez', at },
    '2026-10-21|Jason Leidy': { name: 'Jason Leidy', day: '2026-10-21', note: '', by: APP_BY, at },
    '2026-10-14|Old Past': { name: 'Old Past', day: '2026-10-14', note: '', by: APP_BY, at },   // outside its week: dropped
    '2026-10-18|Sun Day': { name: 'Sun Day', day: '2026-10-18', note: '', by: 'Jose A Julien', at },  // yesterday
  },
  '2026-10-25': {
    '2026-10-27|Jason Leidy': { name: 'Jason Leidy', day: '2026-10-27', note: '', by: APP_BY, at: null },
  },
  '2026-11-01': null,                                                             // read failed: skipped
};
const SMW = { '2026-10-18': SM, '2026-10-25': null, '2026-11-01': undefined };

const next = requestRows(OFF, SMW, rangeOf(T, 'next'));
eq('next rows', next.map((r) => [r.day, r.name, r.status.state]), [
  ['2026-10-20', 'Ana Road', 'scheduled'], ['2026-10-20', 'Jason Leidy', 'scheduled'],
  ['2026-10-21', 'Jason Leidy', 'off'], ['2026-10-27', 'Jason Leidy', 'unbuilt']]);
eq('row fields', [next[1].note, next[1].src.label, next[1].week, next[0].src.label], ['court', 'Driver app', '2026-10-18', 'Maria']);
eq('source filter app', requestRows(OFF, SMW, { ...rangeOf(T, 'next'), source: 'app' }).map((r) => r.name), ['Jason Leidy', 'Jason Leidy', 'Jason Leidy']);
eq('source filter office', requestRows(OFF, SMW, { ...rangeOf(T, 'next'), source: 'office' }).map((r) => r.name), ['Ana Road']);
eq('past rows', requestRows(OFF, SMW, rangeOf(T, 'past')).map((r) => [r.day, r.name, r.status.state]), [['2026-10-18', 'Sun Day', 'off']]);

eq('weekWord', [weekWord('2026-10-18', T), weekWord('2026-10-25', T), weekWord('2026-11-01', T)], ['this week', 'next week', 'week of Nov 1']);
const groups = groupByDay(next, SMW, T);
eq('groups', groups.map((g) => [g.label, g.n, g.unbuilt]), [['Tue Oct 20', 2, ''], ['Wed Oct 21', 1, ''], ['Tue Oct 27', 1, 'next week, not built yet']]);
eq('groups newest first', groupByDay(next, SMW, T, true).map((g) => g.date), ['2026-10-27', '2026-10-21', '2026-10-20']);

const c = conflictsOf(OFF, SMW, T);
eq('conflicts', c, { drivers: 2, groups: [{ date: '2026-10-20', label: 'Tue Oct 20', names: ['Ana Road', 'Jason Leidy'] }] });
// the same driver on two days counts once; yesterday's never counts
const OFF2 = { '2026-10-18': { ...OFF['2026-10-18'],
  '2026-10-23|Jason Leidy': { name: 'Jason Leidy', day: '2026-10-23', note: '', by: APP_BY, at } } };
const SM2 = week('2026-10-18', { 'Jason Leidy': { Tue: '10:45 AM', Fri: '11:05 AM' }, 'Sun Day': { Sun: '10:05 AM' } });
eq('conflicts one driver two days', conflictsOf(OFF2, { '2026-10-18': SM2 }, T).drivers, 1);
eq('conflicts none', conflictsOf({}, {}, T), { drivers: 0, groups: [] });

// --- offers
const offers = [
  { id: 'a', kind: 'vet', date: '2026-10-21', role: 'road', wave: '10:45 AM', slots: 3, taken: 1, status: 'open', mode: 'fcfs', at: 2 },
  { id: 'b', kind: 'vto', date: '2026-10-20', slots: 2, taken: 0, status: 'open', mode: 'window', decideAt: new Date(2026, 9, 23, 18, 0).getTime(), at: 1 },
  { id: 'c', kind: 'vet', date: '2026-10-22', role: 'backup', wave: '', slots: 1, taken: 0, status: 'closed', mode: 'fcfs', at: 3 },
  { id: 'd', kind: 'vet', date: '2026-10-17', role: 'road', wave: '', slots: 1, taken: 1, status: 'filled', mode: 'fcfs', at: 4 },
  { id: 'e', kind: 'vet', date: '2026-10-19', role: 'road', wave: '', slots: 2, taken: 2, status: 'filled', mode: 'fcfs', at: 5 },
];
const L = offerLists(offers, T);
eq('open offers', L.open.map((o) => o.id), ['e', 'b', 'a']);
eq('closed / past offers', L.closed.map((o) => o.id), ['c', 'd']);
eq('offerRole', offers.map(offerRole), ['road · 10:45 AM', 'day off', 'backup · any wave', 'road · any wave', 'road · any wave']);
eq('offerLine fcfs (offer count)', offerLine(offers[0]), '1 of 3 taken · open · first come');
eq('offerLine takes', offerLine(offers[0], [{ status: 'approved' }, { status: 'applied' }, { status: 'waiting' }]), '2 of 3 taken · open · first come');
eq('offerLine window', offerLine(offers[1], []), '0 of 2 taken · open · picks at Fri 6 PM');
eq('offerLine full / closed', [offerLine(offers[4]), offerLine(offers[2])], ['2 of 2 taken · full · first come', '0 of 1 taken · closed · first come']);
eq('takeTone', ['approved', 'applied', 'waiting', 'pending', 'refused', 'declined', 'x'].map((s) => takeTone({ status: s })),
  ['ok', 'ok', 'wait', 'wait', 'gray', 'gray', 'gray']);

console.log(`requests_test: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

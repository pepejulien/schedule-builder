// Requests page helpers (public/app/live/requests-model.js): days off vs the Live schedule, the
// day groups, the conflicts alert / nav badge, and the VET / VTO lists.   node tests/requests_test.mjs
import {
  APP_BY, fold, shiftISO, sundayOf, rangeOf, weeksBetween, sourceOf, askedLabel, shiftWords, scheduleStatus,
  requestRows, weekWord, groupByDay, conflictsOf, offerLists, offerRole, offerLine, takeTone,
  monthOf, shiftMonth, longDate, monthGrid, driverMatch, dayViews,
  refusedText, pendingReviews, reviewsWaiting, applyProblem, denyReason, weekPublished, reviewActions, CALL_OFF_WHY, PUBLISHED_NOTE,
  BLOCKED_WARN, blockReason, blockedOf, unavailRule, standingUnavailable, OFF_MODES, offMode, offCounts, offChip, bothLine, liveWorking,
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

// --- the calendar
eq('monthOf / shiftMonth', [monthOf('2026-10-19'), shiftMonth('2026-10', 1), shiftMonth('2026-12', 1), shiftMonth('2026-01', -1)],
  ['2026-10', '2026-11', '2027-01', '2025-12']);
eq('longDate', longDate('2026-10-14'), 'Wednesday, October 14, 2026');
const G = monthGrid('2026-10');
eq('grid label', G.label, 'October 2026');
eq('grid 42 days, Sunday first', [G.cells.length, G.cells[0].date, G.cells[41].date], [42, '2026-09-27', '2026-11-07']);
eq('grid in month', [G.cells[3].inMonth, G.cells[4], G.cells.filter((x) => x.inMonth).length], [false, { date: '2026-10-01', num: 1, inMonth: true }, 31]);
eq('grid weeks', G.weeks, ['2026-09-27', '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01']);
eq('grid Feb 2026 (starts on a Sunday)', [monthGrid('2026-02').cells[0].date, monthGrid('2026-02').cells[41].date], ['2026-02-01', '2026-03-14']);
eq('driverMatch', [driverMatch('Jason Leidy', ''), driverMatch('Jason Leidy', 'jason leidy'), driverMatch('Jason Leidy', 'leid'), driverMatch('Ana Road', 'jason')],
  [true, true, true, false]);

// days off on Tue Oct 20 (one still scheduled) + Wed Oct 21, a VET with a waiting take + a counter on Tue,
// a VTO filled on Tue, a closed VET on Wed with a stale pending take (closed: not pending)
const CO = [
  { id: 'v1', kind: 'vet', date: '2026-10-20', role: 'road', wave: '10:45 AM', slots: 3, taken: 1, status: 'open', at: 1 },
  { id: 't1', kind: 'vto', date: '2026-10-20', slots: 2, taken: 2, status: 'filled', at: 2 },
  { id: 'v2', kind: 'vet', date: '2026-10-21', role: 'backup', wave: '', slots: 1, taken: 0, status: 'closed', at: 3 },
  { id: 'x', kind: 'vet', date: '2026-12-01', slots: 1, taken: 0, status: 'open', at: 4 },               // outside: ignored
];
const TK = {
  v1: [{ name: 'Gus Fewer', status: 'approved' }, { name: 'Ivy Blank', status: 'waiting' }, { name: 'Hal Dispatch', status: 'pending', counter: true }],
  t1: [{ name: 'Ana Road', status: 'approved' }, { name: 'Eve Extra', status: 'applied' }],
  v2: [{ name: 'Ivy Blank', status: 'pending' }],
};
const SRC = { offByWeek: OFF, smByWeek: SMW, offers: CO, takesById: TK };
const V = dayViews('2026-10-18', '2026-10-24', SRC);
eq('dayViews dates', Object.keys(V), ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
eq('chips Tue (order: still scheduled, pending, off, VET, VTO)', V['2026-10-20'].chips.map((c) => [c.kind, c.text, !!c.faded]), [
  ['conflict', '⊘ 2 sched', false], ['pending', '⏱ 2 wait', false], ['off', '✓ 2 req', false],
  ['vet', 'VET 1/3', false], ['vto', 'VTO 2/2', true]]);
eq('chip titles', V['2026-10-20'].chips.map((c) => c.title), [
  '2 drivers asked off but are still on the schedule', '2 VET / VTO takes waiting for an answer', '✓ 2 requested — 2 drivers asked for the day off',
  'VET · road · 10:45 AM · 1 of 3 taken · open · first come', 'VTO · day off · 2 of 2 taken · full · first come']);
eq('chips Wed (closed VET faded, its take not pending)', V['2026-10-21'].chips.map((c) => [c.kind, c.text, !!c.faded, c.title]), [
  ['off', '✓ 1 req', false, '✓ 1 requested — 1 driver asked for the day off'], ['vet', 'VET 0/1', true, 'VET · backup · any wave · 0 of 1 taken · closed · first come']]);
eq('chips empty day', V['2026-10-22'], { waiting: [], offs: [], denied: [], offers: [], chips: [], blocked: null,
  counts: { mode: 'requested', requested: [], weekly: [], also: [], total: 0 }, working: 0 });
eq('day offers VET first', V['2026-10-20'].offers.map((o) => o.id), ['v1', 't1']);
eq('day offs', V['2026-10-20'].offs.map((r) => [r.name, r.status.state]), [['Ana Road', 'scheduled'], ['Jason Leidy', 'scheduled']]);
eq('filter days off only', dayViews('2026-10-20', '2026-10-20', SRC, { show: 'off' })['2026-10-20'].chips.map((c) => c.kind), ['conflict', 'off']);
eq('filter VTO only', dayViews('2026-10-20', '2026-10-20', SRC, { show: 'vto' })['2026-10-20'].chips.map((c) => c.text), ['VTO 2/2']);
eq('filter VET only', dayViews('2026-10-20', '2026-10-20', SRC, { show: 'vet' })['2026-10-20'].chips.map((c) => c.text), ['⏱ 2 wait', 'VET 1/3']);
const IV = dayViews('2026-10-20', '2026-10-21', SRC, { driver: 'ivy blank' });
eq('driver filter: their offers and pending only', [IV['2026-10-20'].chips.map((c) => c.text), IV['2026-10-21'].chips.map((c) => c.text)],
  [['⏱ 1 wait', 'VET 1/3'], ['VET 0/1']]);
eq('driver filter: their days off', dayViews('2026-10-20', '2026-10-21', SRC, { driver: 'Jason' })['2026-10-21'].chips.map((c) => c.text), ['✓ 1 req']);
eq('takes not read yet: counts from the offer, no pending', dayViews('2026-10-20', '2026-10-20', { offers: CO })['2026-10-20'].chips.map((c) => c.text),
  ['VET 1/3', 'VTO 2/2']);

// --- day-off reviews
const ms = (d, h) => new Date(2026, 9, d, h, 0).getTime();
const RV = [
  { id: 'A_2026-10-20', name: 'Kathy Deaton', week: '2026-10-18', day: '2026-10-20', note: 'funeral', refused: 'full', status: 'pending', at: ms(18, 9) },
  { id: 'B_2026-10-20', name: 'Jason Leidy', week: '2026-10-18', day: '2026-10-20', note: '', refused: 'closed', status: 'pending', at: ms(18, 8) },
  { id: 'C_2026-10-21', name: 'Ana Road', week: '2026-10-18', day: '2026-10-21', refused: 'closed', status: 'approved', decidedBy: 'Jose A Julien', at: ms(17, 8),
    applyResult: { ok: false, how: 'live', text: 'Wed is a training-pair day (10:45 AM TRAIN helper): only a rebuild of the week changes it. Change it by hand.' } },
  { id: 'D_2026-10-20', name: 'Ben Backup', week: '2026-10-18', day: '2026-10-20', refused: 'full', status: 'denied', why: 'Short on drivers', decidedBy: 'Maria Lopez', at: ms(16, 8) },
  { id: 'E_2026-10-20', name: 'Eve Extra', week: '2026-10-18', day: '2026-10-20', refused: 'full', status: 'cancelled', at: ms(16, 9) },
  { id: 'F_2026-10-27', name: 'Gus Fewer', week: '2026-10-25', day: '2026-10-27', refused: 'closed', status: 'approved', decidedBy: 'Jose A Julien', at: ms(17, 9),
    applyResult: { ok: true, how: 'timeoff', text: 'Saved as a day off' } },
  { id: 'G_2026-10-12', name: 'Old One', week: '2026-10-11', day: '2026-10-12', refused: 'full', status: 'pending', at: ms(10, 9) },
];
eq('refusedText', ['full', 'closed', 'published', 'x'].map((k) => refusedText({ refused: k })),
  ['the day was full', 'requests were closed for that week', 'the app said no', 'the app said no']);
eq('pendingReviews from today', pendingReviews(RV, T).map((r) => r.id), ['B_2026-10-20', 'A_2026-10-20']);
eq('pendingReviews all', pendingReviews(RV).length, 3);
eq('reviewsWaiting', reviewsWaiting(RV, T), { n: 2, groups: [{ date: '2026-10-20', label: 'Tue Oct 20', names: ['Jason Leidy', 'Kathy Deaton'] }] });
eq('applyProblem', [applyProblem(RV[2]), applyProblem(RV[5]), applyProblem(RV[0])], [
  "Couldn't put it on the schedule: Wed is a training-pair day (10:45 AM TRAIN helper): only a rebuild of the week changes it. Change it by hand — fix it on the Live schedule",
  '', '']);
eq('denyReason', [denyReason('  '), denyReason(' Short   on\n drivers '), denyReason('x'.repeat(201)).error ? 'long' : 'ok'],
  [{ error: 'Write the reason — the driver sees it.' }, { why: 'Short on drivers' }, 'long']);

const OFF3 = { '2026-10-25': { '2026-10-27|Gus Fewer': { name: 'Gus Fewer', day: '2026-10-27', note: 'Day-off review approved by Jose A Julien', by: APP_BY, at } } };
const SRC3 = { offByWeek: { ...OFF, ...OFF3 }, smByWeek: { ...SMW, '2026-10-25': null }, offers: CO, takesById: TK, reviews: RV };
const W = dayViews('2026-10-18', '2026-10-31', SRC3);
eq('waiting Tue: by sent time, Live status', W['2026-10-20'].waiting.map((r) => [r.name, r.live.state, r.live.what]),
  [['Jason Leidy', 'scheduled', '10:45 AM'], ['Kathy Deaton', 'off', '']]);
eq('denied Tue (cancelled hidden)', W['2026-10-20'].denied.map((r) => [r.name, r.why]), [['Ben Backup', 'Short on drivers']]);
eq('waiting chip: reviews + takes', W['2026-10-20'].chips.find((c) => c.kind === 'pending'),
  { kind: 'pending', text: '⏱ 4 wait', title: '2 day-off reviews and 2 VET / VTO takes waiting for an answer' });
eq('approved review, no timeoff doc: its own row', W['2026-10-21'].offs.map((r) => [r.name, r.status.state, r.approvedBy || '', !!r.fromReview]),
  [['Ana Road', 'off', 'Jose A Julien', true], ['Jason Leidy', 'off', '', false]]);
ok('approved review, apply failed: its problem', applyProblem(W['2026-10-21'].offs[0].review).startsWith("Couldn't put it on the schedule"));
eq('approved review joins its timeoff doc', W['2026-10-27'].offs.map((r) => [r.name, r.approvedBy, !!r.fromReview, r.key]),
  [['Gus Fewer', 'Jose A Julien', false, '2026-10-27|Gus Fewer']]);
// week already published (Jose 2026-10-19): a waiting review there offers only Close it (= deny, call-off words)
eq('waiting Tue: week 10-18 is published', W['2026-10-20'].waiting.map((r) => [r.name, r.published]), [['Jason Leidy', true], ['Kathy Deaton', true]]);
const RV4 = [{ id: 'H_2026-10-27', name: 'Hal Open', week: '2026-10-25', day: '2026-10-27', refused: 'full', status: 'pending', at: ms(19, 9) },
  { id: 'I_2026-10-20', name: 'Ida Pub', week: '2026-10-18', day: '2026-10-20', refused: 'closed', status: 'pending', at: ms(19, 9) }];
const W4 = dayViews('2026-10-20', '2026-10-27', { smByWeek: { '2026-10-18': SMW['2026-10-18'], '2026-10-25': null }, reviews: RV4 });
eq('not published week: Approve / Deny', [W4['2026-10-27'].waiting[0].published, reviewActions(W4['2026-10-27'].waiting[0])],
  [false, { approve: true, deny: true, close: false, note: '' }]);
eq('published week: only Close it + the note', [W4['2026-10-20'].waiting[0].published, reviewActions(W4['2026-10-20'].waiting[0])],
  [true, { approve: false, deny: false, close: true, note: "Week already published — it's a call-off now" }]);
eq('summary still loading: not known yet -> not published', dayViews('2026-10-20', '2026-10-20', { reviews: RV4 })['2026-10-20'].waiting[0].published, false);
eq('weekPublished', [weekPublished({ a: { drivers: [] } }, 'a'), weekPublished({ a: null }, 'a'), weekPublished({}, 'a'), weekPublished(null, 'a')], [true, false, false, false]);
eq('CALL_OFF_WHY = the hub server words', CALL_OFF_WHY, "The schedule for that week is already out. To miss a day you're scheduled, call off.");
ok('CALL_OFF_WHY passes denyReason as is', denyReason(CALL_OFF_WHY).why === CALL_OFF_WHY);
eq('PUBLISHED_NOTE', PUBLISHED_NOTE, "Week already published — it's a call-off now");
eq('reviews only: one wait chip', dayViews('2026-10-20', '2026-10-20', { reviews: RV })['2026-10-20'].chips,
  [{ kind: 'pending', text: '⏱ 2 wait', title: '2 day-off reviews waiting for an answer' }]);
eq('filter Days off keeps reviews', dayViews('2026-10-20', '2026-10-20', SRC3, { show: 'off' })['2026-10-20'].waiting.length, 2);
eq('filter VET drops reviews', dayViews('2026-10-20', '2026-10-20', SRC3, { show: 'vet' })['2026-10-20'].chips.map((c) => c.text), ['⏱ 2 wait', 'VET 1/3']);
eq('driver filter on reviews', dayViews('2026-10-20', '2026-10-20', SRC3, { driver: 'kathy' })['2026-10-20'].waiting.map((r) => r.name), ['Kathy Deaton']);
eq('conflicts count an approved review still on the schedule', conflictsOf(OFF, SMW, T, [
  { name: 'Jason Leidy', week: '2026-10-18', day: '2026-10-20', status: 'approved' },           // same as his day off: once
  { name: 'Zoé Ñame', week: '2026-10-18', day: '2026-10-23', status: 'approved' },             // Fri dispatch: counts
  { name: 'Ana Road', week: '2026-10-18', day: '2026-10-22', status: 'approved' },             // Thu Unavailable: off
  { name: 'Zoé Ñame', week: '2026-10-18', day: '2026-10-23', status: 'pending' }]), {
  drivers: 3, groups: [{ date: '2026-10-20', label: 'Tue Oct 20', names: ['Ana Road', 'Jason Leidy'] },
    { date: '2026-10-23', label: 'Fri Oct 23', names: ['Zoé Ñame'] }] });
eq('askedLabel ms', [askedLabel(ms(18, 9)), askedLabel(0)], ['asked Sun 9 AM', '']);

// --- blocked days (blackout, Jose 2026-10-19)
eq('blockReason', [blockReason(''), blockReason('  Thanksgiving \n week '), blockReason('x'.repeat(121)).error ? 'long' : 'ok'],
  [{ reason: '' }, { reason: 'Thanksgiving week' }, 'long']);
eq('blockedOf', [blockedOf({ '2026-10-20': { reason: 'x' } }, '2026-10-20'), blockedOf({}, '2026-10-20'), blockedOf(null, 'x')],
  [{ reason: 'x' }, null, null]);
ok('BLOCKED_WARN mentions adding by hand', /blocked/.test(BLOCKED_WARN) && /by hand/.test(BLOCKED_WARN));
const BLK = { '2026-10-20': { day: '2026-10-20', week: '2026-10-18', reason: 'Peak week', by: 'Jose', at: 1 } };
const WB = dayViews('2026-10-20', '2026-10-21', { ...SRC3, blocked: BLK });
eq('blocked chip first, with the reason in the title', WB['2026-10-20'].chips[0],
  { kind: 'blocked', text: '⛔ Blocked', title: "Blocked — no day-off requests from the drivers' app (Peak week)" });
eq('blocked entry on the view; other days none', [WB['2026-10-20'].blocked.reason, WB['2026-10-21'].blocked], ['Peak week', null]);
eq('blocked chip whatever the filter', dayViews('2026-10-20', '2026-10-20', { blocked: BLK }, { show: 'vet' })['2026-10-20'].chips.map((c) => c.kind), ['blocked']);
eq('blocked without a reason', dayViews('2026-10-20', '2026-10-20', { blocked: { '2026-10-20': { reason: '' } } })['2026-10-20'].chips[0].title,
  "Blocked — no day-off requests from the drivers' app");

// --- everyone off a day ("Show everyone's unavailable days", Jose 2026-10-19)
eq('unavailRule', [unavailRule({ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }, 'days'), unavailRule({ days: ['Thu', 'Fri', 'Sat', 'Sun'] }, 'days'),
  unavailRule({ days: ['Mon', 'Wed', 'Fri'] }, 'days'), unavailRule({ days: ['Sat'] }, 'days'), unavailRule({ weekends: { mode: 'alternate', on: '2026-10-24' } }, 'weekend')],
  ['never works Sundays', 'not available Mon–Wed', 'not available Sun, Tue, Thu, Sat', 'only works Saturdays', 'every other weekend — this one is off']);
const NO_TUE = ['Sun', 'Mon', 'Wed', 'Thu', 'Fri', 'Sat'];
const PREFS = { v: 1, drivers: {
  'Kim Pref': { days: NO_TUE }, 'Ana Road': { days: NO_TUE }, 'Gone Person': { days: NO_TUE },
  'Wes Weekend': { weekends: { mode: 'alternate', on: '2026-10-17' } },      // ON Oct 17 -> OFF Oct 24/25
  'Max Days': { maxDays: 4 },                                                 // no day rule: never listed
} };
const ACTIVE = ['Jason Leidy', 'Ana Road', 'Kim Pref', 'Lee Live', 'Pat Work', 'Mo Mark', 'Nina New', 'Wes Weekend', 'Max Days'];
eq('standingUnavailable: active roster only, by name', standingUnavailable(PREFS, ACTIVE, '2026-10-20').map((u) => [u.name, u.why, u.rule]),
  [['Ana Road', 'days', 'never works Tuesdays'], ['Kim Pref', 'days', 'never works Tuesdays']]);
eq('standingUnavailable: no roster = everyone in the prefs', standingUnavailable(PREFS, null, '2026-10-20').map((u) => u.name), ['Ana Road', 'Gone Person', 'Kim Pref']);
eq('standingUnavailable: the weekend rule', standingUnavailable(PREFS, ACTIVE, '2026-10-24').map((u) => [u.name, u.rule]),
  [['Wes Weekend', 'every other weekend — this one is off']]);
const LW = { ...week('2026-10-18', {
  'Jason Leidy': { Tue: '10:45 AM' }, 'Ana Road': { Tue: '' }, 'Kim Pref': { Tue: 'Unavailable' }, 'Lee Live': { Tue: '' },
  'Pat Work': { Tue: '10:45 AM' }, 'Mo Mark': { Tue: '10:45 AM' }, 'Wes Weekend': { Tue: 'Dispatch' }, 'Max Days': { Tue: 'Day off' },
  'Left Driver': { Tue: '' },
}, ['Sat']), marks: [{ name: 'Mo Mark', day: 'Tue', kind: 'off' }] };
// --- "Off counts": Requested / Weekly preference / Both (Jose 2026-10-19) — the Live week's own blanks never count
eq('OFF_MODES / offMode', [OFF_MODES, offMode('both'), offMode('x'), offMode(undefined)], [['requested', 'weekly', 'both'], 'both', 'requested', 'requested']);
const ASKED = ['Jason Leidy', 'Ana Road', 'jason leidy'];        // the same driver twice counts once
const CR = offCounts('requested', ASKED, PREFS, ACTIVE, '2026-10-20');
const CW = offCounts('weekly', ASKED, PREFS, ACTIVE, '2026-10-20');
const CB = offCounts('both', ASKED, PREFS, ACTIVE, '2026-10-20');
eq('offCounts requested', [CR.requested, CR.weekly, CR.total], [['Jason Leidy', 'Ana Road'], [], 2]);
eq('offCounts weekly: every driver whose prefs keep them off that weekday (active only)', [CW.requested, CW.weekly.map((u) => [u.name, u.rule]), CW.total],
  [[], [['Ana Road', 'never works Tuesdays'], ['Kim Pref', 'never works Tuesdays']], 2]);
eq('offCounts both: each driver once, requested wins', [CB.requested, CB.weekly.map((u) => u.name), CB.total], [['Jason Leidy', 'Ana Road'], ['Kim Pref'], 3]);
// Jose 2026-10-19 (Oct 31: Requested 10, Weekly 16, Both 25): the one on both lists is named, and the sum adds up in words
eq('offCounts both: also = on both lists (counted once, as requested); [] in the other modes', [CB.also.map((u) => [u.name, u.rule]), CR.also, CW.also],
  [[['Ana Road', 'never works Tuesdays']], [], []]);
eq('offCounts: Both total = Requested + Weekly - also', CB.total, CR.total + CW.total - CB.also.length);
eq('bothLine', [bothLine(CB), bothLine(offCounts('both', ['Jason Leidy'], PREFS, ACTIVE, '2026-10-20')), bothLine(CR), bothLine(CW), bothLine(null)],
  ['3 people off: 2 requested + 2 weekly − 1 on both lists', '3 people off: 1 requested + 2 weekly', '', '', '']);
eq('offChip per mode', [offChip(CR), offChip(CW), offChip(CB)], [
  { kind: 'off', text: '✓ 2 req', long: '✓ 2 requested', title: '✓ 2 requested — 2 drivers asked for the day off' },
  { kind: 'weekly', text: '↻ 2 wkly', long: '↻ 2 weekly off', title: '↻ 2 weekly off — 2 drivers off this weekday every week (Driver preferences)' },
  { kind: 'both', text: 'Σ 3 off', long: 'Σ 3 people off: 2 requested + 2 weekly − 1 on both lists', title: 'Σ 3 people off: 2 requested + 2 weekly − 1 on both lists' }]);
eq('offChip: nothing to count', [offChip(offCounts('weekly', [], null, ACTIVE, '2026-10-20')), offChip(null)], [null, null]);
eq('offCounts weekly: the every-other-weekend rule on its off Saturday', offCounts('weekly', [], PREFS, ACTIVE, '2026-10-24').weekly.map((u) => u.name), ['Wes Weekend']);
eq('liveWorking: active drivers with a shift (any), marks and blanks out', [liveWorking(LW, ACTIVE, '2026-10-20'), liveWorking(LW, null, '2026-10-20')], [3, 3]);
eq('liveWorking: closed / not published / loading / not that week', [liveWorking(LW, ACTIVE, '2026-10-24'), liveWorking(null, ACTIVE, '2026-10-20'),
  liveWorking(undefined, ACTIVE, '2026-10-20'), liveWorking(LW, ACTIVE, '2026-10-27')], [0, null, null, null]);
const SRC5 = { offByWeek: OFF, smByWeek: { '2026-10-18': LW }, prefs: PREFS, activeNames: ACTIVE };
const chipsOf = (f) => dayViews('2026-10-20', '2026-10-20', SRC5, f)['2026-10-20'].chips.map((c) => c.text);
eq('dayViews: the mode decides the count chip (default Requested); no Live-schedule count', [chipsOf({}), chipsOf({ counts: 'weekly' }), chipsOf({ counts: 'both' })],
  [['⊘ 1 sched', '✓ 2 req'], ['⊘ 1 sched', '↻ 2 wkly'], ['⊘ 1 sched', 'Σ 3 off']]);
eq('dayViews: working for context only', dayViews('2026-10-20', '2026-10-20', SRC5)['2026-10-20'].working, 3);
eq('dayViews: driver filter on the weekly list', dayViews('2026-10-20', '2026-10-20', SRC5, { counts: 'weekly', driver: 'kim' })['2026-10-20'].counts.weekly.map((u) => u.name), ['Kim Pref']);
eq('dayViews: VET / VTO only -> no counts', [dayViews('2026-10-20', '2026-10-20', SRC5, { show: 'vet', counts: 'both' })['2026-10-20'].counts, chipsOf({ show: 'vet', counts: 'both' })], [null, []]);

console.log(`requests_test: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

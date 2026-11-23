// Drivers who left (2026-11-22, card #1426): public/app/lib/inactive.js — the one "inactive driver" test,
// plus the build's exclude of the ones left out.
//   node tests/inactive_test.mjs
import { inactiveIndex, goneForWeek, isWorkCell, leftTip } from '../public/app/lib/inactive.js';
import { assembleFromWizard } from '../public/app/build-inputs.js';
import { withoutGone, dayViews, conflictsOf, reviewsWaiting } from '../public/app/live/requests-model.js';
import { weekUnavailable } from '../public/app/lib/driver-prefs.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// dispatch/lists as the cloud writes it: Austin Bowen (Amazon offboarded) and Carl Former (status former)
// aren't on `drivers` at all; Dana Leaving has an end date (pendingTerm, Amazon still active)
const active = {
  drivers: ['Alex Keller', 'Dana Leaving', 'Maria José Lopez', 'Pat Dispatcher'],
  info: {
    'Alex Keller': { tid: 'A1B2', hireDate: '2025-01-01', cert: 'EDV' },
    'Dana Leaving': { tid: 'D9', hireDate: '2024-05-01', cert: '', endDate: '2026-11-25' },
    'Maria José Lopez': { tid: '', hireDate: '', cert: 'CDV' },
  },
};
const gone = inactiveIndex(active);

// ---- the rule ----
eq('offboarded (not on the list) = gone', gone('Austin Edward Bowen', '', '2026-11-22'), { why: 'roster' });
eq('former = gone', gone('Carl Former', '', '2026-11-22'), { why: 'roster' });
eq('active driver', gone('Alex Keller', '', '2026-11-22'), false);
eq('dispatcher on the list (no driverInfo)', gone('Pat Dispatcher', '', '2026-11-22'), false);
eq('end date not passed yet', gone('Dana Leaving', '', '2026-11-25'), false);
eq('day after the end date', gone('Dana Leaving', '', '2026-11-26'), { why: 'end', endDate: '2026-11-25' });
eq('no day given: only the roster counts', gone('Dana Leaving', '', ''), false);
eq('first|last match (middle name on the schedule)', gone('Alex J. Keller', '', '2026-11-22'), false);
eq('accents / spaces folded', gone('maria  jose lopez', '', '2026-11-22'), false);
eq('Transporter ID wins over the name', gone('Somebody Else', 'a1b2', '2026-11-22'), false);
eq('no list read = nobody gone', inactiveIndex(null)('Austin Edward Bowen', '', '2026-11-22'), false);
eq('empty list = nobody gone', inactiveIndex({ drivers: [], info: {} })('Austin Edward Bowen', '', '2026-11-22'), false);
{
  // two people share a first|last name: one still here -> the name counts as still here
  const g2 = inactiveIndex({ drivers: ['Sam Lee', 'Sam B Lee'], info: { 'Sam Lee': { endDate: '2026-01-01' }, 'Sam B Lee': {} } });
  eq('shared first|last, one with no end date', g2('Sam X Lee', '', '2026-11-22'), false);
}

// ---- work cells ----
ok('route is work', isWorkCell('10:05 AM'));
ok('backup is work', isWorkCell('10:25 AM Backup'));
ok('training is work', isWorkCell('10:45 AM TRAIN helper (w/ Bo)'));
ok('dispatch is work', isWorkCell('Dispatch'));
ok('empty is not', !isWorkCell(''));
ok('Unavailable is not', !isWorkCell('Unavailable'));
ok('call-out is not', !isWorkCell('Called out') && !isWorkCell('No-show') && !isWorkCell('Day off'));
ok('tips', /offboarded/.test(leftTip({ why: 'roster' })) && /2026-11-25/.test(leftTip({ why: 'end', endDate: '2026-11-25' })));

// ---- the weekly build ----
eq('gone for the whole week', goneForWeek(['Alex Keller', 'Austin Edward Bowen', 'Dana Leaving'], active, '2026-11-22'),
  ['Austin Edward Bowen']);
eq('end date before the Sunday = gone', goneForWeek(['Dana Leaving'], active, '2026-11-29'), ['Dana Leaving']);
{
  const roster = ['Alex Keller', 'Austin Edward Bowen'];
  const w = {
    week: { num: 48, startISO: '2026-11-22', label: 'Week 48' },
    availability: { source: 'export', rosterNames: roster, drivers: roster.map((name) => ({ name, days: {} })), leftOut: ['Austin Edward Bowen'] },
    demand: {}, standing: { exclude: [], bench: [], dispatch: {}, trainingPairs: [] },
  };
  const out = assembleFromWizard(w);
  ok('build excludes who left', out.config && out.config.exclude.includes('Austin Edward Bowen'), JSON.stringify(out.config && out.config.exclude));
  eq('saved standing settings untouched', w.standing.exclude, []);
  const live = assembleFromWizard({ ...w, availability: { ...w.availability, source: 'live' } });
  ok('live availability: not re-excluded here', live.config && !live.config.exclude.includes('Austin Edward Bowen'));
}

// ---- time-off requests of drivers who left (card #1511): requests-model withoutGone ----
{
  const T = '2026-11-22', W = '2026-11-22', P = '2026-11-15';
  const off = {
    [P]: { '2026-11-17|Austin Edward Bowen': { name: 'Austin Edward Bowen', day: '2026-11-17', by: 'Driver app' } },
    [W]: {
      '2026-11-24|Austin Edward Bowen': { name: 'Austin Edward Bowen', day: '2026-11-24', by: 'Driver app' },
      '2026-11-24|Alex Keller': { name: 'Alex Keller', day: '2026-11-24', by: 'Driver app' },
      '2026-11-26|Dana Leaving': { name: 'Dana Leaving', day: '2026-11-26', by: 'Driver app' },   // after her last day
      '2026-11-25|Dana Leaving': { name: 'Dana Leaving', day: '2026-11-25', by: 'Driver app' },   // her last day
      '2026-11-27|Eve Back': { name: 'Eve Back', day: '2026-11-27', by: 'Driver app', closed: 'driver no longer active' },
    },
    '2026-11-29': undefined, '2026-12-06': null,
  };
  const reviews = [
    { id: 'r1', tid: 'X9', name: 'Austin Edward Bowen', week: W, day: '2026-11-25', status: 'pending', at: 1 },
    { id: 'r2', tid: 'A1B2', name: 'Alex Keller', week: W, day: '2026-11-25', status: 'pending', at: 2 },
    { id: 'r3', tid: 'X9', name: 'Austin Edward Bowen', week: W, day: '2026-11-26', status: 'denied', at: 3 },
    { id: 'r4', tid: 'X9', name: 'Austin Edward Bowen', week: P, day: '2026-11-18', status: 'approved', at: 4 },
    { id: 'r5', tid: 'X9', name: 'Austin Edward Bowen', week: W, day: '2026-11-27', status: 'approved', at: 5 },
  ];
  const r = withoutGone(off, reviews, gone, T);
  eq('future day off of a driver who left: dropped', Object.keys(r.off[W]).sort(),
    ['2026-11-24|Alex Keller', '2026-11-25|Dana Leaving']);
  eq('past day off stays as history', Object.keys(r.off[P]), ['2026-11-17|Austin Edward Bowen']);
  ok('loading / failed weeks pass through', r.off['2026-11-29'] === undefined && '2026-11-29' in r.off && r.off['2026-12-06'] === null);
  eq('reviews: pending + future approved dropped; denied + past approved kept', r.reviews.map((x) => x.id), ['r2', 'r3', 'r4']);
  eq('nothing changed in place', Object.keys(off[W]).length, 5);
  eq('the same driver back on the list: a closed day off stays closed',
    Object.keys(withoutGone(off, [], inactiveIndex({ drivers: ['Eve Back', 'Alex Keller'], info: {} }), T).off[W]).includes('2026-11-27|Eve Back'), false);
  eq('no roster read: only hub-closed ones drop', Object.keys(withoutGone(off, reviews, undefined, T).off[W]).length, 4);
  // the page: the day's list, its off count, the waiting reviews and the alert
  const v = dayViews('2026-11-24', '2026-11-25', { offByWeek: r.off, smByWeek: { [W]: null }, reviews: r.reviews }, { counts: 'requested' });
  eq('Tue: only Alex off', v['2026-11-24'].offs.map((x) => x.name), ['Alex Keller']);
  eq('Tue off count: 1', v['2026-11-24'].counts && v['2026-11-24'].counts.total, 1);
  eq('Wed: only Alex waits', v['2026-11-25'].waiting.map((x) => x.name), ['Alex Keller']);
  eq('waiting alert: 1', reviewsWaiting(r.reviews, T).n, 1);
  eq('conflicts still run', conflictsOf(r.off, { [W]: null }, T, r.reviews).drivers, 0);
  // the weekly build ignores a closed day off (it was closed — not reopened if they come back)
  eq('build: closed day off not used', Object.keys(weekUnavailable(null, off[W], W)).sort(), ['Alex Keller', 'Austin Edward Bowen', 'Dana Leaving']);
}

console.log(`inactive: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.error('  FAIL ' + f); process.exit(1); }

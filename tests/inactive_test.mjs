// Drivers who left (2026-11-22, card #1426): public/app/lib/inactive.js — the one "inactive driver" test,
// plus the build's exclude of the ones left out.
//   node tests/inactive_test.mjs
import { inactiveIndex, goneForWeek, isWorkCell, leftTip } from '../public/app/lib/inactive.js';
import { assembleFromWizard } from '../public/app/build-inputs.js';

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

console.log(`inactive: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.error('  FAIL ' + f); process.exit(1); }

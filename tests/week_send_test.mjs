// weekForAmazon / amazonShift (public/app/week-send.js): the week for Amazon's Scheduling page.
//   node tests/week_send_test.mjs
import { weekForAmazon, amazonShift, weekHashDate } from '../public/app/week-send.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

eq('route', amazonShift('10:05 AM'), { kind: 'driver', time: '10:05 AM', what: 'Route' });
eq('backup', amazonShift('10:25 AM Backup'), { kind: 'driver', time: '10:25 AM', what: 'Backup' });
eq('trainee', amazonShift('10:05 AM (TRAIN drives w/ Barry Hughes)'), { kind: 'driver', time: '10:05 AM', what: 'Trainee' });
eq('trainer', amazonShift('10:25 AM (TRAIN helper w/ Tina Trainee)'), { kind: 'helper', time: '10:25 AM', what: 'Trainer' });
eq('dispatch', amazonShift('Dispatch'), { kind: 'dispatcher', what: 'Dispatch' });
eq('meeting', amazonShift('1:00 PM Meeting'), { kind: 'meeting', what: 'Meeting' });
for (const v of ['', 'Unavailable', 'Called out', 'No-show', 'Day off', 'Backup', 'whatever'])
  eq(`nothing for ${JSON.stringify(v)}`, amazonShift(v), null);

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => ({
  day, date: `2026-10-${String(11 + i)}`, open: day !== 'Fri', routes: 3, waves: {} }));
const summary = { v: 1, week: '2026-10-11', label: 'Week-42 (Oct 11 - Oct 17, 2026)', days, drivers: [
  { name: 'Cara Lea Amos', tid: ' A1 ', cells: { Sun: '10:05 AM', Mon: 'Unavailable', Tue: '10:25 AM Backup', Fri: '10:05 AM' } },
  { name: 'Bea Blank', cells: { Sun: '', Mon: 'Called out' } },
  { name: 'Dan Disp', cells: { Thu: 'Dispatch', Sat: '9:00 AM Meeting' } },
] };
const r = weekForAmazon(summary);
eq('week + label', [r.week, r.label, r.error], ['2026-10-11', 'Week-42 (Oct 11 - Oct 17, 2026)', null]);
eq('days', r.days.map((d) => d.open), [true, true, true, true, true, false, true]);
eq('only drivers with shifts', r.drivers.map((d) => d.name), ['Cara Lea Amos', 'Dan Disp']);
eq('closed day left out, tid trimmed', [Object.keys(r.drivers[0].shifts), r.drivers[0].tid], [['Sun', 'Tue'], 'A1']);
eq('dispatch + meeting', r.drivers[1].shifts, { Thu: { kind: 'dispatcher', what: 'Dispatch' }, Sat: { kind: 'meeting', what: 'Meeting' } });
eq('nobody', weekForAmazon({ ...summary, drivers: [] }).error, 'Nobody has a shift that week on the Live board.');
eq('bad week', weekForAmazon({ days: [] }).error, "That Live board week doesn't have 7 days.");
eq('hash', [weekHashDate('#schedweek=2026-10-11'), weekHashDate('#roster=2026-10-11'), weekHashDate('')], ['2026-10-11', null, null]);

console.log(`week_send: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

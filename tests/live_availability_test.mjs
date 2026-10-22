// Next week's availability from the Live board + Driver preferences (2026-10-09):
// public/app/lib/live-availability.js.   node tests/live_availability_test.mjs
import { writeFileSync } from 'node:fs';
import { makeAvailability, missingActive, withExtraDrivers } from '../public/app/lib/live-availability.js';
import { markActive, personKey } from '../public/app/lib/driver-prefs.js';
import { inspectWorkbook } from '../public/app/lib/file-detect.js';
import { weekNumberOf, nextSunday, toISODate } from '../public/app/lib/weeks.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// week numbers: Week 1 holds Jan 1 of its Saturday's year
eq('wk 41', weekNumberOf('2026-10-04'), 41);
eq('wk 42', weekNumberOf('2026-10-11'), 42);
eq('wk 1 of 2026 starts in 2025', weekNumberOf('2025-12-28'), 1);
eq('wk 1 of 2027 starts in 2026', weekNumberOf('2026-12-27'), 1);
eq('wk 52', weekNumberOf('2026-12-20'), 52);
eq('not a Sunday', weekNumberOf('2026-10-05'), null);
// the default week is the one after the week under way
eq('Fri -> next Sun', toISODate(nextSunday(new Date(2026, 9, 9))), '2026-10-11');
eq('Sat -> next day', toISODate(nextSunday(new Date(2026, 9, 10))), '2026-10-11');
eq('Sun -> the Sun after', toISODate(nextSunday(new Date(2026, 9, 11))), '2026-10-18');

const roster = [{ name: 'Zed  Last', tid: 'A1' }, { name: 'cara amos', tier: 'free' }, { name: 'Cara Amos' }, { name: '' }];
const off = { 'CARA AMOS': { Mon: { why: 'timeoff', note: 'dentist' }, Sat: { why: 'weekend' } }, Nobody: { Sun: { why: 'days' } } };
const a = makeAvailability(roster, off, '2026-10-11');
eq('names: deduped, spaces folded, sorted', a.rosterNames, ['cara amos', 'Zed Last']);
eq('counts', a.counts, { drivers: 2, unavail: 2, seed: 0, meeting: 0 });
eq('preview reasons', [a.drivers[0].days.Mon, a.drivers[0].days.Sat, a.drivers[0].days.Tue],
  [{ kind: 'unavail', text: 'Asked off' }, { kind: 'unavail', text: 'Off weekend' }, { kind: '', text: '' }]);
ok('bytes', a.bytes instanceof ArrayBuffer && a.bytes.byteLength > 0);

// read back the way an uploaded export is: an availability file for the week of Oct 11, cells blank
const w = inspectWorkbook(a.bytes, 'Week-42 availability (Live board)', new Date(2026, 9, 9));
eq('detected as availability', w.kind, 'availability');
eq('week Sunday from the headers', w.sundayISO, '2026-10-11');
eq('week number from the name', w.weekNum, 42);
eq('parsed names', w.parsed.drivers.map((d) => d.name), ['cara amos', 'Zed Last']);
eq('cells blank (days off come from the build config)', w.parsed.counts.unavail, 0);

// who is active (2026-10-09): the cloud's list decides; the roster keeps its spellings
eq('personKey', [personKey('Sylvia  M. Slate'), personKey("D'Andre O'Neal"), personKey('')], ['sylvia|slate', 'd|neal', '']);
const cur = [{ name: 'Aaron Bell', tier: 'gold', tid: 'A1' }, { name: 'Bea Cole', tier: null }, { name: 'Sam Lee', tier: null },
  { name: 'Sam J Lee', tier: null }, { name: 'Gone Away', tier: 'free' }];
const m = markActive(cur, ['aaron bell', 'Bea Marie Cole', 'Sylvia Slate', 'Sam Lee', '  ', 'Sylvia  Slate']);
const by = Object.fromEntries(m.map((r) => [r.name, r]));
eq('exact match keeps tier/tid', [by['Aaron Bell'].active, by['Aaron Bell'].tid, by['Aaron Bell'].tier], [true, 'A1', 'gold']);
eq('middle name matches first|last', [by['Bea Cole'].active, 'Bea Marie Cole' in by], [true, false]);
eq('new hire added once', [by['Sylvia Slate'], m.filter((r) => /sylvia/i.test(r.name)).length],
  [{ name: 'Sylvia Slate', tier: null, active: true, isNew: true }, 1]);
eq('shared key: only the exact one', [by['Sam Lee'].active, by['Sam J Lee'].active], [true, false]);
eq('left: not active', by['Gone Away'].active, false);
eq('sorted', m.map((r) => r.name), ['Aaron Bell', 'Bea Cole', 'Gone Away', 'Sam J Lee', 'Sam Lee', 'Sylvia Slate']);
ok('input not changed', !('active' in cur[0]));

// the export path: active drivers the file doesn't have (2026-10-22)
{
  const active = { drivers: ['Alicia Marie Fogle', 'Kyle Stanley Hickman', 'Ben Carter', 'Zack Desk', 'Gus Later'],
    info: { 'Alicia Marie Fogle': { tid: 'T1', hireDate: '2026-10-20' }, 'Kyle Stanley Hickman': { tid: 'T2', hireDate: '2026-10-20' },
      'Ben Carter': { tid: 'T3', hireDate: '2025-01-01' }, 'Gus Later': { tid: 'T4', hireDate: '2026-11-02' } } };
  const m = missingActive(['Ben Q Carter', 'Ann Old'], active, '2026-10-18');
  eq('missing: not in file, drivers only, hired by week end', m.map((x) => x.name), ['Alicia Marie Fogle', 'Kyle Stanley Hickman']);
  eq('missing: tid + hire date', m[0], { name: 'Alicia Marie Fogle', tid: 'T1', hire_date: '2026-10-20' });
  eq('no info yet: whole list', missingActive(['Ben Carter'], { drivers: ['Ben Carter', 'Zed New'], info: {} }, '2026-10-18').map((x) => x.name), ['Zed New']);
  eq('no active list: nothing', missingActive(['x'], null, '2026-10-18'), []);
  const av = { drivers: [{ name: 'Ben Q Carter', days: {} }], rosterNames: ['Ben Q Carter'], counts: { drivers: 1, unavail: 0, seed: 0, meeting: 0 } };
  const w = withExtraDrivers(av, m, '2026-10-18');
  eq('rows added', w.rosterNames, ['Ben Q Carter', 'Alicia Marie Fogle', 'Kyle Stanley Hickman']);
  eq('count', w.counts.drivers, 3);
  eq('not hired yet Sun+Mon, Tue open', [w.drivers[1].days.Sun.text, w.drivers[1].days.Mon.text, w.drivers[1].days.Tue.text], ['Not hired yet', 'Not hired yet', '']);
  const w2 = withExtraDrivers(w, m.slice(1), '2026-10-18');
  eq('leave out one', w2.rosterNames, ['Ben Q Carter', 'Kyle Stanley Hickman']);
}

if (process.argv[2]) writeFileSync(process.argv[2], Buffer.from(a.bytes));   // for the solver check
console.log(`live_availability: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

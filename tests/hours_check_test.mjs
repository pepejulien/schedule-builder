// The Live board's Hours check card (public/app/live/hours-check-model.js): the rules engine's lines
// and the hours actually worked boiled down to the card's rows.   node tests/hours_check_test.mjs
import { hoursCheck, hoursRows, isRouteCell } from '../public/app/live/hours-check-model.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => ({ day, date: `2026-10-${String(18 + i).padStart(2, '0')}` }));
const lim = { max_day_hours: 12 };
const row = (rows, key) => rows.find((r) => r.key === key);

// --- empty input: all clear, the three always-there rows only
{
  const c = hoursCheck([], { days, drivers: [], lim });
  eq('empty: nothing', c, { day12: [], days6: [], overtime: [], over60: [], dayOff: [], run7: [] });
  eq('empty: rows', hoursRows(c), [
    { key: 'day12', title: 'Over 12 hours in a day', tone: 'ok', none: 'None ✓', items: [] },
    { key: 'days6', title: '6 days out of 7', tone: 'ok', none: 'None ✓', items: [] },
    { key: 'overtime', title: 'Overtime', tone: 'ok', none: 'Nobody ✓', items: [] },
  ]);
  eq('no lines at all', hoursRows(hoursCheck(undefined, {})).map((r) => r.tone), ['ok', 'ok', 'ok']);
}

// --- every line kind
{
  const lines = [
    'HOURS-DAY: Ana Diaz 12.6h on Tue 10/20 (max 12h)',
    'HOURS-7DAY: Bo Lee 62.5h in 7 days from Sun 10/18 (max 60h)',
    'DAYS7>5: Cy Moe 6 days in 7 from Sun 10/18',
    'CONSEC>5: Di Fox run=7',
    'UNAVAIL violated: Ed Ray Tue',
    'UNAVAIL violated: Ed Ray Thu',
    'OT: Fay Gil road days over 40h',
    'TOTDAYS: Gus Hu over 5 worked days',
    'DAYCAP: Hal Ito over 4 primary days',
  ];
  const c = hoursCheck(lines, { days, drivers: [], lim });
  eq('HOURS-DAY', c.day12, [{ name: 'Ana Diaz', h: 12.6, label: 'Tue 10/20', iso: '2026-10-20' }]);
  eq('HOURS-7DAY', c.over60, [{ name: 'Bo Lee', detail: '62.5 h in the 7 days from Sun 10/18' }]);
  eq('DAYS7 + TOTDAYS', c.days6, [{ name: 'Cy Moe', detail: '6 days in the 7 from Sun 10/18' }, { name: 'Gus Hu', detail: '6 days this week' }]);
  eq('CONSEC 7', c.run7, [{ name: 'Di Fox', detail: '7 days in a row' }]);
  eq('UNAVAIL, days joined', c.dayOff, [{ name: 'Ed Ray', detail: 'Tue, Thu' }]);
  eq('OT + DAYCAP names', c.overtime.map((x) => x.name), ['Fay Gil', 'Hal Ito']);
  const rows = hoursRows(c);
  eq('row order', rows.map((r) => r.key), ['day12', 'days6', 'overtime', 'over60', 'dayOff', 'run7']);
  eq('day12 text', row(rows, 'day12'), { key: 'day12', title: 'Over 12 hours in a day', tone: 'bad', items: ['Ana Diaz — 12.6 h on Tue 10/20'] });
  eq('days6 text', row(rows, 'days6').items, ['Cy Moe — 6 days in the 7 from Sun 10/18', 'Gus Hu — 6 days this week']);
  eq('over60 text', row(rows, 'over60').items, ['Bo Lee — 62.5 h in the 7 days from Sun 10/18']);
  eq('dayOff row', [row(rows, 'dayOff').title, row(rows, 'dayOff').items], ['Working a day they asked off', ['Ed Ray — Tue, Thu']]);
  eq('run7 row', [row(rows, 'run7').title, row(rows, 'run7').items], ['7 days in a row', ['Di Fox — 7 days in a row']]);
}

// --- padded engine dates, a 6-day run, one entry per person
{
  const c = hoursCheck([
    'DAYS7>5: Cy Moe 6 days in 7 from Sun 09/27',
    'DAYS7>5: Cy Moe 6 days in 7 from Mon 09/28',
    'TOTDAYS: Cy Moe over 5 worked days',
    'CONSEC>5: Jo Kim run=6',
    'CONSEC>5: Cy Moe run=6',
    'HOURS-DAY: Ana Diaz 13h on Sun 10/04 (max 12h)',
  ], { days, drivers: [], lim });
  eq('one per person, unpadded', c.days6, [{ name: 'Cy Moe', detail: '6 days in the 7 from Sun 9/27' },
    { name: 'Jo Kim', detail: '6 days in a row' }]);
  eq('6 in a row is not 7 in a row', c.run7, []);
  eq('HOURS-DAY not this week', c.day12, [{ name: 'Ana Diaz', h: 13, label: 'Sun 10/4', iso: null }]);
}

// --- hours actually worked over the max day, merged with HOURS-DAY without duplicates
{
  const drivers = [
    { name: 'Ana Diaz', act_dates: ['2026-10-20', '2026-10-21'], day_hours: { '2026-10-20': 12.58, '2026-10-21': 12, '2026-10-17': 13 } },
    { name: 'Kai Ng', act_dates: ['2026-10-19'], day_hours: { '2026-10-19': 12.25, '2026-10-22': 14 } },   // Thu: no clock-out
    { name: 'Lu Oh', notScheduled: true, act_dates: ['2026-10-18'], day_hours: { '2026-10-18': 12.01 } },
  ];
  const c = hoursCheck(['HOURS-DAY: Ana Diaz 12.6h on Tue 10/20 (max 12h)'], { days, drivers, lim });
  eq('worked + engine, one per day', c.day12, [
    { name: 'Lu Oh', h: 12.01, label: 'Sun 10/18', iso: '2026-10-18' },
    { name: 'Kai Ng', h: 12.25, label: 'Mon 10/19', iso: '2026-10-19' },
    { name: 'Ana Diaz', h: 12.6, label: 'Tue 10/20', iso: '2026-10-20' },
  ]);
  eq('12.0 exactly is not over', c.day12.some((x) => x.iso === '2026-10-21'), false);
  eq('last week not counted', c.day12.some((x) => x.iso === '2026-10-17'), false);
  eq('no clock-out not counted', c.day12.some((x) => x.iso === '2026-10-22'), false);
  eq('worked only', hoursCheck([], { days, drivers: [drivers[1]], lim }).day12.map((x) => x.h), [12.25]);
  eq('max day from limits', hoursCheck([], { days, drivers: [drivers[1]], lim: { max_day_hours: 13 } }).day12, []);
  eq('row text', row(hoursRows(c), 'day12').items[1], 'Kai Ng — 12.25 h on Mon 10/19');
}

// --- overtime: OT and DAYCAP together, count, route days, hours, sort
{
  const cells = (o) => o;
  const gridDrivers = [
    { name: 'Fay Gil', hours: 50, clock_hours: 48.5, cells: cells({ Sun: '10:45 AM', Mon: '11:05 AM', Tue: '10:45 AM Backup', Wed: '10:45 AM', Thu: '10:45 AM' }) },
    { name: 'Hal Ito', hours: 52, cells: cells({ Sun: '10:45 AM', Mon: '10:45 AM (TRAIN drives w/ Fay Gil)', Tue: '10:45 AM', Wed: '10:45 AM', Thu: '10:45 AM', Fri: 'Unavailable' }) },
    { name: 'Ann Bee', hours: 50, cells: cells({ Sun: '10:45 AM', Mon: '10:45 AM', Tue: '10:45 AM', Wed: '10:45 AM', Thu: '1:00 PM Meeting', Fri: '10:45 AM (TRAIN helper w/ X)' }) },
  ];
  const c = hoursCheck([
    'OT: Fay Gil road days over 40h', 'DAYCAP: Fay Gil over 4 primary days',
    'DAYCAP: Hal Ito over 4 primary days', 'OT: Ann Bee road days over 40h', 'OT: Zed Unknown road days over 40h',
  ], { days, drivers: gridDrivers, lim });
  eq('overtime union + sort', c.overtime, [
    { name: 'Hal Ito', routeDays: 5, hours: 52 },
    { name: 'Ann Bee', routeDays: 4, hours: 50 },
    { name: 'Fay Gil', routeDays: 4, hours: 48.5 },
    { name: 'Zed Unknown', routeDays: 0, hours: null },
  ]);
  const r = row(hoursRows(c), 'overtime');
  eq('overtime row', r, { key: 'overtime', title: 'Overtime', tone: 'warn', lead: '4 drivers', items: [
    'Hal Ito — 5 route days · 52 h', 'Ann Bee — 4 route days · 50 h', 'Fay Gil — 4 route days · 48.5 h', 'Zed Unknown'] });
  eq('one driver', row(hoursRows(hoursCheck(['OT: Fay Gil road days over 40h'], { days, drivers: gridDrivers })), 'overtime').lead, '1 driver');
  eq('custom isRoute', hoursCheck(['OT: Fay Gil road days over 40h'], { days, drivers: gridDrivers, isRoute: () => true }).overtime[0].routeDays, 7);
}

// --- route cells
eq('isRouteCell', ['10:45 AM', '10:45 AM (TRAIN drives w/ A)', '10:45 AM Backup', 'Backup', '10:45 AM (TRAIN helper w/ A)',
  '1:00 PM Meeting', 'Dispatch', 'Unavailable', 'Called out', '', undefined].map(isRouteCell),
  [true, true, false, false, false, false, false, false, false, false, false]);

// --- kinds the card leaves out
{
  const c = hoursCheck([
    'FAIR-SHAPE: Ann Bee roads+backups over 4', 'TARGET Ann Bee: want 4 got 3', 'BACKUP-ONLY: Ann Bee',
    'BACKUP<2PRIMARY: Ann Bee', 'P1 INFEASIBLE Tue: filled 5/6', 'something else entirely',
  ], { days, drivers: [], lim });
  eq('ignored kinds', c, { day12: [], days6: [], overtime: [], over60: [], dayOff: [], run7: [] });
  eq('ignored kinds: all clear', hoursRows(c).map((r) => r.none), ['None ✓', 'None ✓', 'Nobody ✓']);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('FAIL ' + f); process.exit(1); }

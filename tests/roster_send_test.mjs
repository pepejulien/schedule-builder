// rosterForDay (public/app/roster-send.js): who goes in Amazon's DA boxes for a day.
//   node tests/roster_send_test.mjs
import { rosterForDay, rosterHashDate, dayLabel } from '../public/app/roster-send.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => ({
  day, date: `2026-10-${String(4 + i).padStart(2, '0')}`, open: day !== 'Sun', routes: 3, waves: {} }));
const drv = (name, sat, tid = '') => ({ name, tid, cells: { Sat: sat, Fri: '' } });
const summary = {
  v: 1, week: '2026-10-04', label: 'Week-41 (Oct 4 - Oct 10, 2026)', num: 41, days,
  drivers: [
    drv('Zed Late', '11:05 AM', 'TZ9'),
    drv('Barry Len Hughes', '10:25 AM (TRAIN helper w/ Tina Trainee)'),
    drv('Tina Trainee', '10:25 AM (TRAIN drives w/ Barry Hughes)'),
    drv('Cara Amos', '10:05 AM Backup'),
    drv('Dan Disp', 'Dispatch'),
    drv('Una Off', 'Unavailable'),
    drv('Bea Blank', ''),
    drv('Cal Callout', 'Called out'),
    drv('Mel Meeting', '1:00 PM Meeting'),
    drv('Amy Early', '10:05 AM', ' A1B2 '),
    drv('Ann Also', '11:05 AM'),
  ],
};

const r = rosterForDay(summary, '2026-10-10');
eq('dayName', r.dayName, 'Sat');
eq('no error', r.error, null);
eq('week + label carried', [r.week, r.label], ['2026-10-04', 'Week-41 (Oct 4 - Oct 10, 2026)']);
eq('order: wave, then summary order', r.drivers.map((d) => d.name), ['Amy Early', 'Tina Trainee', 'Zed Late', 'Ann Also']);
const amy = r.drivers[0];
eq('plain route', amy, { name: 'Amy Early', tid: 'A1B2', sched: '10:05 AM', portal: '10:25 AM', trainee: false, trainer: null });
const tina = r.drivers[1];
eq('trainee in, portal +20', [tina.sched, tina.portal, tina.trainee], ['10:25 AM', '10:45 AM', true]);
eq('trainee carries the trainer\'s full name', tina.trainer, 'Barry Len Hughes');
eq('no tid -> null', tina.tid, null);
eq('11:05 -> 11:25', r.drivers[2].portal, '11:25 AM');
eq('skipped: trainer + backup', r.skipped, [{ name: 'Barry Len Hughes', why: 'Trainer' }, { name: 'Cara Amos', why: 'Backup' }]);
ok('dispatch / unavailable / blank / mark / meeting ignored',
  !JSON.stringify(r).match(/Dan Disp|Una Off|Bea Blank|Cal Callout|Mel Meeting/), JSON.stringify(r));

// trainer not found by name: the cell's short name stays
const s2 = { ...summary, drivers: [drv('Tina Trainee', '10:25 AM (TRAIN drives w/ Someone Else)')] };
eq('trainer fallback to cell text', rosterForDay(s2, '2026-10-10').drivers[0].trainer, 'Someone Else');

// a day with nobody on routes
const fri = rosterForDay(summary, '2026-10-09');
eq('nobody: no drivers', fri.drivers, []);
ok('nobody: plain-words error', /Nobody is on a route Friday Oct 9/.test(fri.error || ''), fri.error);
// closed day / not in the week
ok('closed day error', /closed/.test(rosterForDay(summary, '2026-10-04').error || ''));
ok('date not in week error', /isn't in this Live board week/.test(rosterForDay(summary, '2026-10-11').error || ''));

// helpers
eq('dayLabel', dayLabel('2026-10-10'), 'Saturday Oct 10');
eq('hash date', rosterHashDate('#roster=2026-10-10'), '2026-10-10');
eq('hash other', rosterHashDate('#foo'), null);
eq('hash bad', rosterHashDate('#roster=2026-10-1'), null);

console.log(`${pass}/${pass + fail} passed`);
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('ALL PASS');

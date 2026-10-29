// Roster bookmark, moved drivers (Jose 2026-10-23): the pure parts of public/app/roster-moves.js
// (message check, what to do per move) and public/roster.js's Amazon -> schedule time.
//   node tests/roster_moves_test.mjs
import { readFileSync } from 'node:fs';
import { checkMovesMsg, planMoves, rosterMovesHashDate } from '../public/app/roster-moves.js';
import { portalToSchedule } from '../public/app/lib/waves.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// ---- the hash
eq('hash date', rosterMovesHashDate('#roster-moves=2026-10-24'), '2026-10-24');
eq('hash: the roster window is not it', rosterMovesHashDate('#roster=2026-10-24'), null);
eq('hash bad', rosterMovesHashDate('#roster-moves=2026-10-4'), null);

// ---- the message
const msg = (moves, extra = {}) => ({ type: 'jajb-roster-moves', date: '2026-10-24', week: '2026-10-18', rev: 7, moves, ...extra });
const tia = { name: ' Tiamia Allen Schwalbe ', tid: ' T1 ', from: '10:05 AM', to: '10:25 AM' };
eq('good message', checkMovesMsg(msg([tia]), '2026-10-24'),
  { moves: [{ name: 'Tiamia Allen Schwalbe', tid: 'T1', from: '10:05 AM', to: '10:25 AM' }], rev: 7 });
eq('no tid -> null, no rev -> null', checkMovesMsg(msg([{ ...tia, tid: '' }], { rev: 'x' }), '2026-10-24'),
  { moves: [{ name: 'Tiamia Allen Schwalbe', tid: null, from: '10:05 AM', to: '10:25 AM' }], rev: null });
eq('empty list is fine', checkMovesMsg(msg([]), '2026-10-24').moves, []);
ok('wrong type', !!checkMovesMsg({ ...msg([tia]), type: 'jajb-roster' }, '2026-10-24').error);
ok('not an object', !!checkMovesMsg(null, '2026-10-24').error);
ok('other day', /Saturday Oct 24/.test(checkMovesMsg(msg([tia], { date: '2026-10-25' }), '2026-10-24').error || ''));
ok('bad date', /another day/.test(checkMovesMsg(msg([tia], { date: 'x' }), '2026-10-24').error || ''));
ok('no list', !!checkMovesMsg(msg(null), '2026-10-24').error);
ok('Amazon-style time refused', !!checkMovesMsg(msg([{ ...tia, to: '10:25 am' }]), '2026-10-24').error);
ok('leading zero refused', !!checkMovesMsg(msg([{ ...tia, from: '09:45 AM' }]), '2026-10-24').error);
ok('same time refused', !!checkMovesMsg(msg([{ ...tia, to: '10:05 AM' }]), '2026-10-24').error);
ok('no name refused', !!checkMovesMsg(msg([{ ...tia, name: '  ' }]), '2026-10-24').error);
ok('too many refused', !!checkMovesMsg(msg(Array(201).fill(tia)), '2026-10-24').error);

// ---- what to do per move (an engine report / summary: drivers[].cells, days[].waves)
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => ({
  day, date: `2026-10-${String(18 + i).padStart(2, '0')}`, open: day !== 'Fri',
  waves: day === 'Sat' ? { '10:05 AM': 9, '10:25 AM': 11, '10:45 AM': 14 } : {} }));
const drv = (name, sat, tid = '') => ({ name, tid, cells: { Sat: sat } });
const rep = { days, drivers: [
  drv('Tiamia Allen Schwalbe', '10:05 AM', 'T1'),
  drv('Tina Trainee', '10:05 AM (TRAIN drives w/ Cara Amos)'),
  drv('Cara Amos', '10:05 AM (TRAIN helper w/ Tina Trainee)'),
  drv('Ben Backup', '10:05 AM Backup'),
  drv('Moe Moved', '10:45 AM'),
  drv('José Núñez', '10:25 AM'),
  drv('Ida Byid', '10:45 AM', 'T9'),
] };
const mv = (name, from, to, tid = null) => ({ name, tid, from, to });
const p = planMoves(rep, '2026-10-24', [
  mv('Tiamia Allen Schwalbe', '10:05 AM', '10:25 AM', 'T1'),
  mv('Tina Trainee', '10:05 AM', '10:25 AM'),
  mv('Cara Amos', '10:05 AM', '10:25 AM'),
  mv('Moe Moved', '10:05 AM', '10:25 AM'),
  mv('Ben Backup', '10:05 AM', '10:25 AM'),
  mv('Jose Nunez', '10:25 AM', '10:45 AM'),
  mv('Ida B', '10:45 AM', '10:25 AM', 'T9'),
  mv('Nobody Here', '10:05 AM', '10:25 AM'),
  mv('Tiamia Allen Schwalbe', '10:05 AM', '10:45 AM'),
  mv('Ida Byid', '10:45 AM', '11:05 AM'),
]);
eq('day name', p.dayName, 'Sat');
eq('route -> apply_wave with the count', p.steps[0],
  { name: 'Tiamia Allen Schwalbe', from: '10:05 AM', to: '10:25 AM',
    payload: { day: 'Sat', name: 'Tiamia Allen Schwalbe', wave: '10:25 AM', move_count: true, note: 'to match Amazon' } });
ok('trainee refused, pair named', !p.steps[1].payload && /training pair with Cara Amos/.test(p.steps[1].why), p.steps[1].why);
ok('trainer refused', !p.steps[2].payload && /training pair/.test(p.steps[2].why), p.steps[2].why);
eq('not at from any more', p.steps[3].why, 'the Live board changed — not at 10:05 AM any more');
eq('a backup is not a route at from', p.steps[4].why, 'the Live board changed — not at 10:05 AM any more');
eq('accents / case: the board name goes to the engine', p.steps[5].payload && p.steps[5].payload.name, 'José Núñez');
eq('found by Transporter ID', p.steps[6].payload && p.steps[6].payload.name, 'Ida Byid');
eq('not on the week', p.steps[7].why, 'not on the Live board week any more');
eq('twice', p.steps[8].why, 'in the list twice');
ok('only the payload steps carry no why', p.steps.every((s) => !!s.payload !== !!s.why), JSON.stringify(p.steps));
// Ida's first move is in the list already; a wave the board doesn't have that day
const p2 = planMoves(rep, '2026-10-24', [mv('Ida Byid', '10:45 AM', '11:05 AM')]);
eq('a wave the board has no count at yet still goes to the engine (it adds the wave)', p2.steps[0].payload && p2.steps[0].payload.wave, '11:05 AM');
ok('closed day', /closed/.test(planMoves(rep, '2026-10-23', [mv('Tiamia Allen Schwalbe', '10:05 AM', '10:25 AM')]).error || ''));
ok('not in the week', /isn't in this Live board week/.test(planMoves(rep, '2026-10-31', []).error || ''));

// ---- roster.js: Amazon's start time -> the schedule's, the same as lib/waves.js portalToSchedule
const src = readFileSync(new URL('../public/roster.js', import.meta.url), 'utf8');
const fn = (src.match(/function toSched\(k\) \{[\s\S]*?\n {2}\}/) || [])[0];
ok('roster.js has toSched', !!fn);
if (fn) {
  const toSched = new Function(`${fn}; return toSched;`)();
  for (const t of ['10:45 AM', '10:25 AM', '10:05 AM', '11:25 AM', '12:10 PM', '12:15 AM', '1:05 PM', '9:40 AM', '12:00 PM', '10:45 am', '11:05 am'])
    eq(`toSched ${t}`, toSched(t), portalToSchedule(t));
  eq('toSched junk', toSched('Backup'), null);
}
// and the moves message roster.js sends uses the keys the app checks
ok('roster.js sends jajb-roster-moves with date, week, rev, moves', /type: "jajb-roster-moves", date: mv\.date, week: mv\.week, rev: mv\.rev, moves: mv\.list/.test(src));
ok('roster.js sends only placed moves', /filter\(\(r\) => r\.status === "placed"\)/.test(src));

console.log(`${pass}/${pass + fail} passed`);
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('ALL PASS');

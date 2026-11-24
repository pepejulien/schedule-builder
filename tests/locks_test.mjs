// Locked days (2026-11-20): public/app/lib/locks.js + what config-assemble hands the solver, then one real
// build of the Week-40 fixture through runner.py with the locks in it.
//   node tests/locks_test.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockId, dayText, lockList, lockOf, locksByDriver, lockConflicts, conflictQuestion, locksForBuild, lockState, lockTip,
  lockShort, lockLine, meetingText }
  from '../public/app/lib/locks.js';
import { assembleConfig, LOCKS_FAILED_MSG } from '../public/app/lib/config-assemble.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

const W = '2026-08-02';                    // the Week-40 fixture's Sunday
const L = (driverKey, date, x = {}) => ({ [lockId(date, driverKey)]: { driverKey, date, note: '', training: false, trainer: '', by: 'Jose', at: null, ...x } });

// ---- helpers ----
eq('dayText', dayText('2026-11-24'), 'Tue 11/24');
const locks = { ...L('Aaron Bell', '2026-08-04'), ...L('jessica jett', '2026-08-05', { training: true, trainer: 'Alex Keller' }),
  ...L('Cara Amos', '2026-08-12'), ...L('Bianca Cole', '2026-08-06', { training: true }), bad: { driverKey: 'X', date: 'soon' } };
eq('lockList: this week only, by date', lockList(locks, W).map((l) => l.driverKey), ['Aaron Bell', 'jessica jett', 'Bianca Cole']);
ok('lockOf: case / spacing', lockOf(locks, 'Jessica  Jett', '2026-08-05') && !lockOf(locks, 'Jessica Jett', '2026-08-04'));
ok('locksByDriver', locksByDriver(locks)['aaron bell']['2026-08-04'].driverKey === 'Aaron Bell');

// ---- clashes with time off ----
const timeoff = { '2026-08-04|Aaron Bell': { name: 'Aaron Bell', day: '2026-08-04', note: 'Doctor' } };
const reviews = [{ name: 'Aaron Bell', day: '2026-08-04', status: 'approved' },           // the same day, applied
  { name: 'Bianca Cole', day: '2026-08-06', status: 'pending', note: 'wedding' },
  { name: 'Bianca Cole', day: '2026-08-07', status: 'denied' }];
const ca = lockConflicts('aaron bell', '2026-08-04', { timeoff, reviews });
eq('time off on file = approved, once', ca.map((c) => c.kind + ':' + c.status), ['timeoff:approved']);
eq('the question names it', conflictQuestion(ca, '2026-08-04'), 'Has approved time off on Tue 8/4 (“Doctor”), lock anyway?');
const cb = lockConflicts('Bianca Cole', '2026-08-06', { timeoff, reviews });
eq('a pending review', cb.map((c) => c.status), ['pending']);
ok('pending wording', /waiting for review/.test(conflictQuestion(cb, '2026-08-06')) && /wedding/.test(conflictQuestion(cb, '2026-08-06')));
eq('denied = no clash', lockConflicts('Bianca Cole', '2026-08-07', { timeoff, reviews }), []);
eq('no time off = no question', conflictQuestion([], '2026-08-04'), '');
ok('trainer wording', conflictQuestion([{ ...ca[0], who: 'Trainer Alex Keller' }], '2026-08-04').startsWith('Trainer Alex Keller has approved'));

// ---- solver keys ----
const roster = ['Daniel Lynch', 'Cara Amos', 'Matthew Dutton', 'Aaron Bell', 'Bianca Cole', 'Colin Drake', 'Casey Church',
  'Joshua Workman', 'Grace Nolan', 'Alex Keller', 'Jessica Jett', 'Connor Stephenson', 'Karl Berkley', 'Zackary McDonald'];
const fb = locksForBuild({ ...locks, ...L('Nobody New', '2026-08-03') }, W, roster);
eq('locked_days', fb.locked_days.map((l) => `${l.name} ${l.day}`), ['Nobody New Mon', 'Aaron Bell Tue', 'Jessica Jett Wed', 'Bianca Cole Thu']);
eq('a picked trainer = a manual pair', fb.pairs, [{ trainer: 'Alex Keller', trainee: 'Jessica Jett', day: 'Wed', manual: true }]);
eq('no trainer = the builder picks', fb.autos, [{ trainee: 'Bianca Cole', day: 'Thu' }]);
eq('not on the roster', fb.unmatched, ['Nobody New']);
eq('lockState', [lockState({ working: true }).kind, lockState({ working: false, why: 'no route' }).text, lockState({}).kind],
  ['ok', 'locked, no route', 'off']);
ok('lockTip', /can't be changed once the week is published/.test(lockTip({ training: true, trainer: 'Alex Keller', by: 'Jose' })));

// ---- config-assemble ----
const tierByDriver = Object.fromEntries(roster.map((n) => [n, { tier: 'Fair', routes: 12, rate: -20, groupValue: 'free' }]));
const day = (a, b) => [{ portalTime: '11:05 AM', count: String(a) }, { portalTime: '11:25 AM', count: String(b) }];
const state = {
  week: { num: '40', startISO: W, label: 'Week-40' },
  availabilityRosterNames: roster, tierByDriver,
  demand: { Sun: day(4, 2), Mon: day(4, 2), Tue: day(4, 2), Wed: day(3, 2), Thu: day(4, 2), Sat: day(3, 1) },
  backups: { mode: 'pct', pct: 0.15 },
  standing: { exclude: ['Zackary McDonald'], bench: [], dispatch: {}, trainers: ['Alex Keller', 'Grace Nolan'],
    trainingPairs: [{ trainer: 'Grace Nolan', trainee: 'Jessica Jett' }, { trainer: '__auto__', trainee: 'Bianca Cole' }] },
  advanced: {}, priorWeekAvailable: false,
};
const none = assembleConfig(state).config;
ok('no locks: no key', !('locked_days' in none));
const { config: c, warnings } = assembleConfig({ ...state, weekLocks: locks });
eq('config.locked_days', c.locked_days.map((l) => l.name), ['Aaron Bell', 'Jessica Jett', 'Bianca Cole']);
eq('the manual pair replaces the Step-7 pair', c.training_pairs, [{ trainer: 'Alex Keller', trainee: 'Jessica Jett', day: 'Wed', manual: true }]);
eq('the Auto pair trains on the locked date', c.auto_training.map((a) => [a.trainee, a.day, a.pool]), [['Bianca Cole', 'Thu', ['Alex Keller', 'Grace Nolan']]]);
eq('trainees get their usual 3 days', [c.exact_days['Jessica Jett'], c.exact_days['Bianca Cole']], [3, 3]);
eq('no warnings', warnings, []);
const lone = assembleConfig({ ...state, standing: { ...state.standing, trainingPairs: [] },
  weekLocks: L('Colin Drake', '2026-08-04', { training: true }) }).config;
eq('a training lock with no pair set up: a new Auto pair', lone.auto_training.map((a) => [a.trainee, a.day]), [['Colin Drake', 'Tue']]);
ok('read failed: warned', assembleConfig({ ...state, locksFailed: true }).warnings.includes(LOCKS_FAILED_MSG));
ok('not on roster: warned', assembleConfig({ ...state, weekLocks: L('Nobody New', '2026-08-03') }).warnings.some((w) => /Nobody New/.test(w)));

// ---- one real build: the Week-40 fixture with the locks ----
const FIX = decodeURIComponent(new URL('./fixtures', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const SOLVER = decodeURIComponent(new URL('../public/solver', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const tmp = mkdtempSync(join(tmpdir(), 'locks-'));
const cfg = { ...c, strict_names: false, avail_file: FIX + '/Week-40-availability.xlsx', prev_week_file: FIX + '/Week-39-Schedule.xlsx',
  prefs_csv: null, out: join(tmp, 'out.xlsx') };
writeFileSync(join(tmp, 'c.json'), JSON.stringify(cfg));
let rep = null;
try {
  const py = `import sys, json, io, contextlib; sys.path.insert(0, ${JSON.stringify(SOLVER)}); import runner
buf = io.StringIO()
with contextlib.redirect_stdout(buf): out = runner.run(${JSON.stringify(join(tmp, 'c.json'))})
print(out)`;
  rep = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', py], { encoding: 'utf-8' }).trim().split('\n').pop());
} catch (e) { ok('python build ran', false, String(e.message || e).slice(0, 300)); }
if (rep) {
  ok('build ok', rep.ok, rep.message);
  const row = (n) => rep.drivers.find((d) => d.name === n) || {};
  const on = (n, d) => [...(row(n).road_days || []), ...(row(n).backup_days || []), ...(row(n).helper_days || [])].includes(d);
  ok('Aaron works the locked Tue', on('Aaron Bell', 'Tue'), JSON.stringify(row('Aaron Bell').cells));
  ok('Jessica trains Wed with Alex', rep.pairlog.some((p) => p.join() === 'Alex Keller,Jessica Jett,Wed'), JSON.stringify(rep.pairlog));
  ok('Bianca trains Thu, trainer from the rotation', rep.pairlog.some((p) => p[1] === 'Bianca Cole' && p[2] === 'Thu'), JSON.stringify(rep.pairlog));
  ok('every lock placed', rep.locks.length === 3 && rep.locks.every((l) => l.working), JSON.stringify(rep.locks));
  ok('no rule errors', !rep.check.errors.filter((e) => /^(UNAVAIL|CONSEC|DAYS7|DUP)/.test(e)).length, rep.check.errors.join('; '));
}

// shift / time / label (2026-11-24)
{
  const L = { 'a': { driverKey: 'Aaron Bell', date: '2026-11-24', shift: 'meeting', time: '9:00 AM', label: 'Safety' },
    'b': { driverKey: 'Bianca Cole', date: '2026-11-25', shift: 'dispatch', time: '9:00 AM' },
    'c': { driverKey: 'Jessica Jett', date: '2026-11-26', time: '10:45 AM' } };
  const fb2 = locksForBuild(L, '2026-11-22', ['Aaron Bell', 'Bianca Cole', 'Jessica Jett']);
  const by = (n) => fb2.locked_days.find((l) => l.name === n);
  ok('meeting row', by('Aaron Bell').shift === 'meeting' && by('Aaron Bell').time === '9:00 AM' && by('Aaron Bell').label === 'Safety Meeting', JSON.stringify(by('Aaron Bell')));
  ok('dispatch row, no time', by('Bianca Cole').shift === 'dispatch' && !('time' in by('Bianca Cole')), JSON.stringify(by('Bianca Cole')));
  ok('timed route row', !('shift' in by('Jessica Jett')) && by('Jessica Jett').time === '10:45 AM', JSON.stringify(by('Jessica Jett')));
  ok('short words', [lockShort(L.a), lockShort(L.b), lockShort(L.c), lockShort({})].join('|') === '9:00 AM Safety Meeting|Dispatch|Route 10:45 AM|Working');
  ok('meeting text adds the word once', meetingText({ time: '1:00 PM', label: 'Team meeting' }) === '1:00 PM Team meeting');
  ok('lockLine', lockLine(L.a) === 'Locked: Safety Meeting at 9:00 AM', lockLine(L.a));
}

console.log(`locks: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.error('  FAIL ' + f); process.exit(1); }

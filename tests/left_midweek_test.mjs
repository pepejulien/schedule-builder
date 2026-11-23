// A last day inside the build week (2026-11-22, card #1733): lib/inactive.js lastDaysInWeek -> config-assemble
// makes every day after the roster endDate a hard day off ('left'), then real builds of the Week-40 fixture
// show a driver whose last day is Wednesday gets no shifts Thursday to Saturday.
//   node tests/left_midweek_test.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastDaysInWeek, goneForWeek } from '../public/app/lib/inactive.js';
import { assembleConfig } from '../public/app/lib/config-assemble.js';
import { lockId } from '../public/app/lib/locks.js';
import { WHY_LABEL } from '../public/app/lib/driver-prefs.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

const W = '2026-08-02';                    // the Week-40 fixture's Sunday (Wed = 08-05)
const roster = ['Daniel Lynch', 'Cara Amos', 'Matthew Dutton', 'Aaron Bell', 'Bianca Cole', 'Colin Drake', 'Casey Church',
  'Joshua Workman', 'Grace Nolan', 'Alex Keller', 'Jessica Jett', 'Connor Stephenson', 'Karl Berkley', 'Zackary McDonald'];
const active = { drivers: roster.filter((n) => n !== 'Karl Berkley'), info: {
  'Daniel Lynch': { tid: 'D1', endDate: '2026-08-05' },            // last day Wednesday
  'Cara Amos': { tid: 'C1', endDate: '2026-07-30' },               // gone before the week
  'Aaron Bell': { tid: 'A1', endDate: '2026-08-08' },              // last day Saturday = the whole week
  'Bianca Cole': { tid: 'B1', endDate: '2026-08-20' },             // after the week
} };

// ---- the shared test ----
eq('only a last day inside the week', lastDaysInWeek(roster, active, W), { 'Daniel Lynch': '2026-08-05' });
eq('a last day before the Sunday = gone for the week', goneForWeek(roster, active, W).sort(), ['Cara Amos', 'Karl Berkley']);
eq('no list read: nothing', lastDaysInWeek(roster, null, W), {});
eq('bad week: nothing', lastDaysInWeek(roster, active, 'soon'), {});
eq('label', WHY_LABEL.left, 'After their last day');

// ---- config-assemble ----
const tierByDriver = Object.fromEntries(roster.map((n) => [n, { tier: 'Solid', routes: 12, rate: -20 }]));
const day = (a, b) => [{ portalTime: '11:05 AM', count: String(a) }, { portalTime: '11:25 AM', count: String(b) }];
const state = {
  week: { num: '40', startISO: W, label: 'Week-40' },
  availabilityRosterNames: roster, tierByDriver,
  demand: { Sun: day(4, 2), Mon: day(4, 2), Tue: day(4, 2), Wed: day(3, 2), Thu: day(4, 2), Fri: day(3, 2), Sat: day(3, 1) },
  backups: { mode: 'pct', pct: 0.15 },
  standing: { exclude: ['Zackary McDonald'], bench: [], dispatch: {}, trainers: [], trainingPairs: [] },
  advanced: {}, priorWeekAvailable: false,
  weekTimeoff: { [`2026-08-06|Daniel Lynch`]: { name: 'Daniel Lynch', day: '2026-08-06', note: '' } },
};
const base = assembleConfig({ ...state, weekTimeoff: null });
ok('no last days: no extra days off', !base.config.extra_unavailable, JSON.stringify(base.config.extra_unavailable));
const lockThu = { [lockId('2026-08-06', 'Daniel Lynch')]: { driverKey: 'Daniel Lynch', date: '2026-08-06', note: '', training: false, trainer: '', by: 'Jose', at: null },
  [lockId('2026-08-04', 'Daniel Lynch')]: { driverKey: 'Daniel Lynch', date: '2026-08-04', note: '', training: false, trainer: '', by: 'Jose', at: null } };
const { config: c, warnings, prefsInfo } = assembleConfig({ ...state, leftAfter: { 'daniel lynch': '2026-08-05' }, weekLocks: lockThu });
eq('Thu-Sat hard days off, "left" wins over an asked-off day', c.extra_unavailable['Daniel Lynch'], { Thu: 'left', Fri: 'left', Sat: 'left' });
eq('review card says why', prefsInfo.off['Daniel Lynch'].Fri, { why: 'left', note: 'last day 2026-08-05' });
eq('a lock after the last day is dropped, the one before kept', c.locked_days.map((l) => l.day), ['Tue']);
ok('... and said', warnings.some((w) => /after their last day/.test(w) && /Daniel Lynch Thu/.test(w)), warnings.join(' | '));
eq('nobody else touched', Object.keys(c.extra_unavailable), ['Daniel Lynch']);
ok('an excluded driver: nothing', !assembleConfig({ ...state, leftAfter: { 'Zackary McDonald': '2026-08-03' } }).config.extra_unavailable?.['Zackary McDonald']);
ok('last day Saturday: nothing', !assembleConfig({ ...state, weekTimeoff: null, leftAfter: { 'Aaron Bell': '2026-08-08' } }).config.extra_unavailable);

// ---- real builds: without and with the last day ----
const FIX = decodeURIComponent(new URL('./fixtures', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const SOLVER = decodeURIComponent(new URL('../public/solver', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
function build(cfg0, tag) {
  const tmp = mkdtempSync(join(tmpdir(), 'leftmid-'));
  const cfg = { ...cfg0, strict_names: false, avail_file: FIX + '/Week-40-availability.xlsx', prev_week_file: FIX + '/Week-39-Schedule.xlsx',
    prefs_csv: null, out: join(tmp, 'out.xlsx') };
  writeFileSync(join(tmp, 'c.json'), JSON.stringify(cfg));
  const py = `import sys, json, io, contextlib; sys.path.insert(0, ${JSON.stringify(SOLVER)}); import runner
buf = io.StringIO()
with contextlib.redirect_stdout(buf): out = runner.run(${JSON.stringify(join(tmp, 'c.json'))})
print(out)`;
  try {
    return JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', py], { encoding: 'utf-8' }).trim().split('\n').pop());
  } catch (e) { ok(`python build ran (${tag})`, false, String(e.message || e).slice(0, 300)); return null; }
}
const blocks = (rep, n) => { const r = rep.drivers.find((d) => d.name === n) || {};
  return [...(r.road_days || []), ...(r.backup_days || []), ...(r.helper_days || []), ...(r.dispatch_days || []), ...(r.meeting_days || [])]; };
const late = ['Thu', 'Fri', 'Sat'];
const before = build(base.config, 'before');
const after = build(assembleConfig({ ...state, weekTimeoff: null, leftAfter: { 'Daniel Lynch': '2026-08-05' } }).config, 'after');
if (before && after) {
  ok('builds ok', before.ok && after.ok, `${before.message} / ${after.message}`);
  ok('without it, Daniel works Thu-Sat (the gap this fixes)', blocks(before, 'Daniel Lynch').some((d) => late.includes(d)),
    JSON.stringify(blocks(before, 'Daniel Lynch')));
  eq('last day Wednesday: no blocks Thursday to Saturday', blocks(after, 'Daniel Lynch').filter((d) => late.includes(d)), []);
  const cells = (after.drivers.find((d) => d.name === 'Daniel Lynch') || {}).cells || {};
  eq('Thu-Sat show Unavailable', late.map((d) => cells[d]), ['Unavailable', 'Unavailable', 'Unavailable']);
  ok('still works before it', blocks(after, 'Daniel Lynch').some((d) => !late.includes(d)), JSON.stringify(blocks(after, 'Daniel Lynch')));
  ok('no rule errors', !after.check.errors.filter((e) => /^(UNAVAIL|CONSEC|DAYS7|DUP)/.test(e)).length, after.check.errors.join('; '));
}

console.log(`left_midweek: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.error('  FAIL ' + f); process.exit(1); }

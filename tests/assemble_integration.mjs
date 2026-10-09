// Integration test: build a realistic wizard state, run it through the REAL
// config-assembler, point the file paths at the generated fixtures, and write
// the config so the Python solver can run it. Proves config-assemble produces a
// solver-valid config end-to-end (not just the expected shape).
//   deno run --allow-write tests/assemble_integration.mjs   or   node tests/assemble_integration.mjs
// Also writes Week-40-prefs-config.json: the same week with Driver preferences +
// requested days off, for tests/driver_prefs_solver_test.py-style solver runs.
import { assembleConfig } from '../public/app/lib/config-assemble.js';

const FIX = decodeURIComponent(new URL('./fixtures', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const writeText = async (path, text) => {
  if (globalThis.Deno) return Deno.writeTextFileSync(path, text);
  const fs = await import('node:fs');
  fs.writeFileSync(path, text);
};
const exit = (code) => (globalThis.Deno ? Deno.exit(code) : process.exit(code));

// Roster matches tests/fixtures/Week-40-availability.xlsx (from gen_fixtures.py).
const roster = ['Daniel Lynch', 'Cara Amos', 'Matthew Dutton', 'Aaron Bell', 'Bianca Cole',
  'Colin Drake', 'Casey Church', 'Joshua Workman', 'Grace Nolan', 'Alex Keller',
  'Jessica Jett', 'Connor Stephenson', 'Karl Berkley', 'Zackary McDonald'];

const tierByDriver = {
  'Daniel Lynch': { tier: 'Top performer', routes: 15, rate: -4, groupValue: 'most' },
  'Cara Amos': { tier: 'Top performer', routes: 16, rate: -8, groupValue: 'most' },
  'Matthew Dutton': { tier: 'Solid', routes: 14, rate: -12, groupValue: 'most' },
  'Aaron Bell': { tier: 'Fair', routes: 12, rate: -20, groupValue: 'free' },
  'Bianca Cole': { tier: 'Fair', routes: 11, rate: -22, groupValue: 'free' },
  'Colin Drake': { tier: 'Fair', routes: 10, rate: -25, groupValue: 'free' },
  'Casey Church': { tier: 'Underperforming', routes: 8, rate: -45, groupValue: 'reduced' },
  'Joshua Workman': { tier: 'Solid', routes: 3, rate: -6, groupValue: 'exact:3' },
  'Grace Nolan': { tier: 'Fair', routes: 12, rate: -18, groupValue: 'free' },
  'Alex Keller': { tier: 'Fair', routes: 13, rate: -16, groupValue: 'free' },
  'Jessica Jett': { tier: 'Unrated', routes: null, rate: null, groupValue: 'exact:3' },
  'Connor Stephenson': { tier: 'Fair', routes: 9, rate: -24, groupValue: 'free' },
  'Karl Berkley': { tier: 'Unrated', routes: null, rate: null, groupValue: 'bench' },
};

// HR enters PORTAL times; assembler subtracts 20 min. portal 11:05 -> sched 10:45,
// portal 11:25 -> sched 11:05 (small, coverable demand across 6 days; Fri closed).
const day = (a, b) => [{ portalTime: '11:05 AM', count: String(a) }, { portalTime: '11:25 AM', count: String(b) }];
const demand = {
  Sun: day(4, 2), Mon: day(4, 2), Tue: day(4, 2), Wed: day(3, 2), Thu: day(4, 2), Sat: day(3, 1),
};

const state = {
  week: { num: '40', startISO: '2026-08-02', label: 'Week-40 (Aug 2 - Aug 8, 2026)' },
  availabilityRosterNames: roster,
  tierByDriver,
  demand,
  backups: { mode: 'pct', pct: 0.15 },
  standing: {
    exclude: ['Zackary McDonald', 'Rachel Rhoades', 'Greyson Turner'], // last two not on roster -> pruned
    bench: [],
    dispatch: { 'Connor Stephenson': ['Fri', 'Sat'] },
    trainingPairs: [{ trainer: 'Alex Keller', trainee: 'Jessica Jett' }],
    hasPrefs: true,
  },
  advanced: {},
  priorWeekAvailable: true,
};

const { config, nameProblems } = assembleConfig(state);
if (nameProblems.length) {
  console.error('NAME PROBLEMS:', nameProblems);
  exit(1);
}

// Point at the real fixture files instead of the /work/* runtime paths.
config.avail_file = FIX + '/Week-40-availability.xlsx';
config.prev_week_file = FIX + '/Week-39-Schedule.xlsx';
config.prefs_csv = FIX + '/Driver-Preferences.csv';
config.out = FIX + '/Week-40-assembled-out.xlsx';

await writeText(FIX + '/Week-40-assembled-config.json', JSON.stringify(config, null, 2));
console.log('Wrote assembled config. most_days=', config.most_days,
  '| exact=', config.exact_days, '| reduced=', config.reduced_days.names,
  '| exclude=', config.exclude, '| waves.Sun=', config.waves.Sun);

// ---------------------------------------------------------------- Driver preferences ---
// Week-40 starts Sun 2026-08-02; its Saturday is 2026-08-08.
let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// empty prefs / no prefs -> no keys at all
for (const [label, extra] of [['none', {}], ['empty doc', { driverPrefs: { v: 1, drivers: {} }, weekTimeoff: {} }]]) {
  const c = assembleConfig({ ...state, ...extra }).config;
  for (const k of ['extra_unavailable', 'driver_max_days', 'driver_max_row', 'keep_together', 'prefer_days', 'like_days']) {
    ok(`${label}: ${k} absent`, !(k in c));
  }
}

const driverPrefs = { v: 1, drivers: {
  'Daniel Lynch': { maxDays: 4, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] },   // can't work Sun
  'grace nolan': { maxRow: 2, together: true },                                      // case differs from roster
  'Cara Amos': { weekends: { mode: 'alternate', on: '2026-08-08' } },                // ON this Sat, OFF Sun (Aug 1-2 weekend)
  'Aaron Bell': { weekends: { mode: 'alternate', on: '2026-08-01' } },               // ON Sun, OFF Sat
  'Bianca Cole': { days: ['Mon', 'Tue', 'Wed'] },                                    // timeoff on Sun wins over "can't work"
  'Zackary McDonald': { maxDays: 2 },                                                // excluded -> skipped
  'Nobody Here': { maxDays: 3, days: ['Mon'] },                                      // not on the roster
} };
const weekTimeoff = {
  '2026-08-05|Daniel Lynch': { name: 'Daniel Lynch', day: '2026-08-05', note: 'dentist' },
  '2026-08-02|Bianca Cole': { name: 'Bianca Cole', day: '2026-08-02' },
  '2026-08-09|Colin Drake': { name: 'Colin Drake', day: '2026-08-09' },              // next week -> ignored
  '2026-08-04|Someone Else': { name: 'Someone Else', day: '2026-08-04' },
};
const out = assembleConfig({ ...state, driverPrefs, weekTimeoff });
const pc = out.config;
eq('extra_unavailable Daniel', pc.extra_unavailable['Daniel Lynch'], { Sun: 'days', Wed: 'timeoff' });
eq('extra_unavailable Grace (no days rule)', pc.extra_unavailable['Grace Nolan'], undefined);
eq('extra_unavailable Cara off Sun (weekend parity)', pc.extra_unavailable['Cara Amos'], { Sun: 'weekend' });
eq('extra_unavailable Aaron off Sat', pc.extra_unavailable['Aaron Bell'], { Sat: 'weekend' });
eq('timeoff wins over days', pc.extra_unavailable['Bianca Cole'].Sun, 'timeoff');
eq('Bianca days', Object.keys(pc.extra_unavailable['Bianca Cole']).sort(), ['Fri', 'Sat', 'Sun', 'Thu']);
ok('next-week timeoff ignored', !pc.extra_unavailable['Colin Drake']);
ok('excluded skipped', !pc.extra_unavailable['Zackary McDonald'] && !('Zackary McDonald' in pc.driver_max_days));
ok('unmatched kept as-is (unavail)', !!pc.extra_unavailable['Nobody Here'] && !!pc.extra_unavailable['Someone Else']);
eq('driver_max_days', pc.driver_max_days, { 'Daniel Lynch': 4, 'Nobody Here': 3 });
eq('driver_max_row (name mapped to roster spelling)', pc.driver_max_row, { 'Grace Nolan': 2 });
eq('keep_together', pc.keep_together, ['Grace Nolan']);
eq('prefer_days = ON-weekend days', pc.prefer_days, { 'Cara Amos': ['Sat'], 'Aaron Bell': ['Sun'] });
eq('no strict-name problems from prefs', out.nameProblems, []);
eq('info.unmatched', out.prefsInfo.unmatched, ['Nobody Here', 'Someone Else']);
eq('info.limits Daniel', out.prefsInfo.limits['Daniel Lynch'], { maxDays: 4 });
eq('info.off note kept', out.prefsInfo.off['Daniel Lynch'].Wed, { why: 'timeoff', note: 'dentist' });
eq('info.limits Grace (together)', out.prefsInfo.limits['Grace Nolan'], { maxRow: 2, together: true });
eq('info.limits Cara (weekend on Sat)', out.prefsInfo.limits['Cara Amos'], { weekend: { on: ['Sat'] } });
// like_days (very soft): roster-matched, closed Fri + this week's days off dropped, excluded skipped
const lk = assembleConfig({ ...state, weekTimeoff, driverPrefs: { v: 1, drivers: {
  'Daniel Lynch': { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], likeDays: ['Sun', 'Wed', 'Thu', 'Fri'] },  // Sun can't, Wed asked off, Fri closed
  'grace nolan': { likeDays: ['Sat', 'Mon', 'Tue'] },
  'Colin Drake': { likeDays: ['Fri'] },                                              // only a closed day -> nothing
  'Zackary McDonald': { likeDays: ['Mon'] },                                         // excluded
  'Nobody Here': { likeDays: ['Tue'] },                                              // not on the roster
} } });
eq('like_days', lk.config.like_days, { 'Daniel Lynch': ['Thu'], 'Grace Nolan': ['Mon', 'Tue', 'Sat'], 'Nobody Here': ['Tue'] });
eq('like_days info.limits', lk.prefsInfo.limits['Grace Nolan'], { likes: ['Mon', 'Tue', 'Sat'] });
eq('like_days info.limits Daniel', lk.prefsInfo.limits['Daniel Lynch'], { likes: ['Thu'] });
ok('like_days: closed-only driver has no entry', !lk.prefsInfo.limits['Colin Drake']);
ok('like_days: unmatched listed', lk.prefsInfo.unmatched.includes('Nobody Here'));
ok('like_days absent when none', !('like_days' in out.config));
const lkAll = assembleConfig({ ...state, driverPrefs: { v: 1, drivers: { 'Daniel Lynch': { likeDays: ['Fri'] } } } });
ok('like_days: only closed days -> key absent', !('like_days' in lkAll.config));
const PREFS_W = "Couldn't read driver preferences — this build doesn't use them.";
const TIME_W = "Couldn't read the days off asked for this week — check the connection, then build again.";
ok('ok reads: no failure warnings', !out.warnings.includes(PREFS_W) && !out.warnings.includes(TIME_W));
// prefs read failed, time off fine -> time off still applies, no prefs keys
const pf = assembleConfig({ ...state, driverPrefs: null, weekTimeoff, driverPrefsFailed: true });
eq('prefs failed: only time off', pf.config.extra_unavailable,
  { 'Daniel Lynch': { Wed: 'timeoff' }, 'Bianca Cole': { Sun: 'timeoff' }, 'Someone Else': { Tue: 'timeoff' } });
ok('prefs failed: no prefs keys', ['driver_max_days', 'driver_max_row', 'keep_together', 'prefer_days', 'like_days'].every((k) => !(k in pf.config)));
ok('prefs failed: prefs warning only', pf.warnings.includes(PREFS_W) && !pf.warnings.includes(TIME_W));
// time-off read failed, prefs fine -> prefs still apply, no 'timeoff' days
const tf = assembleConfig({ ...state, driverPrefs, weekTimeoff: null, timeoffFailed: true });
ok('time off failed: no timeoff days', Object.values(tf.config.extra_unavailable).every((d) => !Object.values(d).includes('timeoff')));
eq('time off failed: prefs days still in', tf.config.extra_unavailable['Daniel Lynch'], { Sun: 'days' });
eq('time off failed: caps still in', tf.config.driver_max_days, { 'Daniel Lynch': 4, 'Nobody Here': 3 });
ok('time off failed: time-off warning only', tf.warnings.includes(TIME_W) && !tf.warnings.includes(PREFS_W));
// both failed -> no keys, both warnings
const bf = assembleConfig({ ...state, driverPrefsFailed: true, timeoffFailed: true });
ok('both failed: no keys', !('extra_unavailable' in bf.config) && !('driver_max_days' in bf.config));
ok('both failed: both warnings', bf.warnings.includes(PREFS_W) && bf.warnings.includes(TIME_W));

// solver run input: Aaron Bell (works Wed without prefs) asks off Wed + a 4-day cap
const sc = assembleConfig({ ...state, driverPrefs: { v: 1, drivers: { 'Aaron Bell': { maxDays: 4 } } },
  weekTimeoff: { '2026-08-05|Aaron Bell': { name: 'Aaron Bell', day: '2026-08-05' } } }).config;
Object.assign(sc, { avail_file: config.avail_file, prev_week_file: config.prev_week_file,
  prefs_csv: config.prefs_csv, out: FIX + '/Week-40-prefs-out.xlsx' });
await writeText(FIX + '/Week-40-prefs-config.json', JSON.stringify(sc, null, 2));

console.log(`driver prefs: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.error('  FAIL ' + f); exit(1); }

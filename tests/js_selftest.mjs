// Headless version of public/selftest.js — runs the pure front-end logic under
// Deno (no DOM) so it can be executed in CI / locally. Run:
//   deno run tests/js_selftest.mjs
import { computeTiers } from '../public/app/lib/board-metrics.js';
import { normalizePortal, portalToSchedule } from '../public/app/lib/waves.js';
import { norm, resolveFuzzy, matchName } from '../public/app/lib/names.js';
import { deriveGroup, hasTierOverlap, assembleConfig } from '../public/app/lib/config-assemble.js';
import { weekLabel, isSunday } from '../public/app/lib/weeks.js';
import { driverCsv } from '../public/app/lib/driver-csv.js';
import { readiness } from '../public/app/readiness.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// waves
eq('portal 10:45 -> 10:25', portalToSchedule('10:45 AM'), '10:25 AM');
eq('portal 11:05 -> 10:45', portalToSchedule('11:05 AM'), '10:45 AM');
eq('normalize 10:45', normalizePortal('10:45 AM'), '10:45 AM');
eq('bad time null', portalToSchedule('nope'), null);

// weeks
ok('sunday', isSunday('2026-08-02'));
ok('not sunday', !isSunday('2026-08-03'));
eq('week label', weekLabel(40, '2026-08-02'), 'Week-40 (Aug 2 - Aug 8, 2026)');

// names
eq('norm', norm('  Cara   Amos '), 'cara amos');
eq('resolveFuzzy', resolveFuzzy('Cara', ['Cara Amos', 'Colin Drake']), ['Cara Amos']);
ok('Hunt not token Hunter', matchName('Hunt', ['Hunter Green']).status !== 'token');
eq('exact', matchName('Cara Amos', ['Cara Amos']).match, 'Cara Amos');

// board metrics
const asof = '2026-07-15', D = '2026-07-01';
function drv(name, o = {}) {
  const events = [];
  for (let i = 0; i < (o.low || 0); i++) events.push({ track: 'safety', d: D });
  for (let i = 0; i < (o.ncns || 0); i++) events.push({ track: 'ncns', d: D });
  return { name, events, strikes: [], backing: [0, 0], exp: o.noexp ? [] : [[D, 15, 3000]] };
}
const db = {
  asof, meritPerRescue: 3,
  pen: { lowsev: 1, highsev: 4, ncns: 5, callout: 2, cdf: 1, strike: 3, stuck: 1, dsb: 1 },
  drivers: [drv('Top One'), drv('Solid One', { low: 1 }), drv('Fair One', { low: 3 }),
    drv('Under One', { low: 7 }), drv('Term Rate', { low: 11 }), drv('Term NCNS', { ncns: 2 }),
    drv('Unrated One', { noexp: true })],
};
const byName = Object.fromEntries(computeTiers(db, 30).map((t) => [t.name, t.tier]));
eq('Top', byName['Top One'], 'Top performer');
eq('Solid', byName['Solid One'], 'Solid');
eq('Fair', byName['Fair One'], 'Fair');
eq('Under', byName['Under One'], 'Underperforming');
eq('Term rate', byName['Term Rate'], 'Termination review');
eq('Term ncns', byName['Term NCNS'], 'Termination review');
eq('Unrated', byName['Unrated One'], 'Unrated');

// config-assemble
eq('deriveGroup Top', deriveGroup('Top performer', 15), { kind: 'most' });
eq('deriveGroup Fair', deriveGroup('Fair', 15), { kind: 'free' });
eq('deriveGroup <5', deriveGroup('Solid', 3), { kind: 'exact', n: 3 });
eq('deriveGroup disc', deriveGroup('Underperforming', 3), { kind: 'reduced' });
ok('overlap', hasTierOverlap('Top performer', 3));
ok('no overlap', !hasTierOverlap('Top performer', 15));

const state = {
  week: { num: '40', startISO: '2026-08-02', label: 'Week-40 (Aug 2 - Aug 8, 2026)' },
  availabilityRosterNames: ['Daniel Lynch', 'Aaron Bell', 'Casey Church', 'Joshua Workman', 'Karl Berkley'],
  tierByDriver: {
    'Daniel Lynch': { tier: 'Top performer', routes: 15, rate: -4, groupValue: 'most' },
    'Aaron Bell': { tier: 'Fair', routes: 12, rate: -20, groupValue: 'free' },
    'Casey Church': { tier: 'Underperforming', routes: 8, rate: -45, groupValue: 'reduced' },
    'Joshua Workman': { tier: 'Solid', routes: 3, rate: -6, groupValue: 'exact:3' },
    'Karl Berkley': { tier: 'Unrated', routes: null, rate: null, groupValue: 'bench' },
  },
  demand: { Sun: [{ portalTime: '10:45 AM', count: '4' }, { portalTime: '11:05 AM', count: '2' }] },
  backups: { mode: 'pct', pct: 0.15 },
  standing: { exclude: ['Zackary McDonald'], bench: [], dispatch: {}, trainingPairs: [], hasPrefs: false },
  advanced: {}, priorWeekAvailable: false,
};
const { config, nameProblems } = assembleConfig(state);
eq('most_days', config.most_days, ['Daniel Lynch']);
eq('reduced', config.reduced_days.names, ['Casey Church']);
eq('exact incl bench=0', config.exact_days, { 'Joshua Workman': 3, 'Karl Berkley': 0 });
eq('waves sched', config.waves.Sun, { '10:25 AM': 4, '10:45 AM': 2 });
eq('exclude pruned', config.exclude, []);
eq('prev null', config.prev_week_file, null);
ok('no name problems', nameProblems.length === 0, JSON.stringify(nameProblems));

// advanced overrides
const advState = { ...state, advanced: {
  max_primary_days: 3, max_weekend_days: 1, merge_standing_unavailable: true, backup_eligible_extra: ['Casey Church'],
}, standing: { ...state.standing, hasPrefs: true } };
const advCfg = assembleConfig(advState).config;
eq('adv max_primary_days override', advCfg.max_primary_days, 3);
eq('adv max_weekend_days emitted', advCfg.max_weekend_days, 1);
eq('adv merge_standing_unavailable (prefs on)', advCfg.merge_standing_unavailable, true);
eq('adv backup_eligible_extra canonicalized', advCfg.backup_eligible_extra, ['Casey Church']);
// off by default: no weekend cap / merge when not set
eq('no max_weekend_days by default', assembleConfig(state).config.max_weekend_days, undefined);
eq('no merge by default', assembleConfig(state).config.merge_standing_unavailable, undefined);

// driver CSV
const report = { drivers: [
  { name: 'Beta', cells: { Sun: '10:45 AM', Mon: 'Unavailable', Tue: '', Wed: '', Thu: '', Fri: '', Sat: '10:45 AM Backup' }, hours: 22, cls: 'free' },
  { name: 'Alpha', cells: { Sun: '', Mon: '10:45 AM', Tue: '10:45 AM', Wed: '10:45 AM', Thu: '10:45 AM', Fri: '', Sat: '' }, hours: 40, cls: 'most' },
] };
const csv = driverCsv(report, 'Week-40');
const lines = csv.trim().split('\n');
eq('csv title row', lines[0], 'Week-40');
eq('csv header', lines[1], 'Driver,Sun,Mon,Tue,Wed,Thu,Fri,Sat,Total hours');
ok('csv sorted by name (Alpha before Beta)', lines[2].startsWith('Alpha'), lines[2]);
ok('csv quotes a comma-free cell plainly', lines[3].includes('10:45 AM Backup'), lines[3]);

// readiness (pure, DOM-free) — exercise the field accesses
const wiz = {
  step: 0,
  week: { num: '40', startISO: '2026-08-02', label: 'Week-40 (Aug 2 - Aug 8, 2026)' },
  availability: { counts: { drivers: 5 }, rosterNames: state.availabilityRosterNames },
  tierByDriver: state.tierByDriver,
  tierMeta: { asof: '2026-07-15', fetched: true, warnings: [] },
  priorWeek: { bytes: null, source: 'none' },
  demand: state.demand,
  backups: { mode: 'pct', pct: 0.15 },
  standing: state.standing,
  advanced: {},
  build: { status: 'idle' },
};
const rd = readiness(wiz);
eq('readiness has 9 steps', rd.steps.length, 9);
eq('readiness week done', rd.steps[0].status, 'done');
eq('readiness prior-week warn (none)', rd.steps[3].status, 'warn');
ok('readiness numbers.drivers', rd.numbers.drivers === 5, JSON.stringify(rd.numbers));
ok('readiness firstTodoIdx is a number', typeof rd.firstTodoIdx === 'number');

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  ✗', f)); Deno.exit(1); }
console.log('ALL PASS');

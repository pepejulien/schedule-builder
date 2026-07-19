// In-browser assertions for the pure front-end logic. Renders pass/fail.
import { computeTiers } from './lib/board-metrics.js';
import { normalizePortal, portalToSchedule } from './lib/waves.js';
import { norm, resolveFuzzy, matchName } from './lib/names.js';
import { deriveGroup, hasTierOverlap, assembleConfig } from './lib/config-assemble.js';
import { weekLabel, isSunday } from './lib/weeks.js';
import { driverCsv } from './lib/driver-csv.js';

const results = [];
function ok(name, cond, detail) { results.push({ name, pass: !!cond, detail }); }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`); }

// ---- waves ----
eq('portal 10:45 -> schedule 10:25', portalToSchedule('10:45 AM'), '10:25 AM');
eq('portal 11:05 -> schedule 10:45', portalToSchedule('11:05 AM'), '10:45 AM');
eq('normalize "1045"', normalizePortal('10:45 AM'), '10:45 AM');
eq('bad time -> null', portalToSchedule('nope'), null);

// ---- weeks ----
ok('2026-08-02 is Sunday', isSunday('2026-08-02'));
ok('2026-08-03 not Sunday', !isSunday('2026-08-03'));
eq('week label', weekLabel(40, '2026-08-02'), 'Week-40 (Aug 2 - Aug 8, 2026)');

// ---- names ----
eq('norm', norm('  Cara   Amos '), 'cara amos');
eq('resolveFuzzy Kara?', resolveFuzzy('Cara', ['Cara Amos', 'Colin Drake']), ['Cara Amos']);
ok('Hunt does not token-match Hunter', matchName('Hunt', ['Hunter Green']).status !== 'token');
eq('exact match', matchName('Cara Amos', ['Cara Amos']).match, 'Cara Amos');

// ---- board metrics ----
const asof = '2026-07-15';
const D = '2026-07-01';
function drv(name, opts = {}) {
  const events = [];
  for (let i = 0; i < (opts.low || 0); i++) events.push({ track: 'safety', d: D });
  for (let i = 0; i < (opts.ncns || 0); i++) events.push({ track: 'ncns', d: D });
  return { name, events, strikes: [], backing: [0, 0], exp: opts.noexp ? [] : [[D, 15, 3000]] };
}
const db = {
  asof, meritPerRescue: 3,
  pen: { lowsev: 1, highsev: 4, ncns: 5, callout: 2, cdf: 1, strike: 3, stuck: 1, dsb: 1 },
  drivers: [
    drv('Top One', {}),               // no penalties -> Top performer
    drv('Solid One', { low: 1 }),     // rateScore ~ -6.5 -> Solid
    drv('Fair One', { low: 3 }),      // ~ -19.6 -> Fair
    drv('Under One', { low: 7 }),     // ~ -45.7 -> Underperforming
    drv('Term Rate', { low: 11 }),    // ~ -71.7 -> Termination review
    drv('Term NCNS', { ncns: 2 }),    // override -> Termination review
    drv('Unrated One', { noexp: true }), // routes 0 -> Unrated
  ],
};
const tiers = computeTiers(db, 30);
const byName = Object.fromEntries(tiers.map((t) => [t.name, t.tier]));
eq('tier Top', byName['Top One'], 'Top performer');
eq('tier Solid', byName['Solid One'], 'Solid');
eq('tier Fair', byName['Fair One'], 'Fair');
eq('tier Underperforming', byName['Under One'], 'Underperforming');
eq('tier Term (rate)', byName['Term Rate'], 'Termination review');
eq('tier Term (ncns override)', byName['Term NCNS'], 'Termination review');
eq('tier Unrated', byName['Unrated One'], 'Unrated');
eq('routes computed', tiers.find((t) => t.name === 'Top One').routes, 15);

// ---- config-assemble ----
eq('deriveGroup Top', deriveGroup('Top performer', 15), { kind: 'most' });
eq('deriveGroup Fair', deriveGroup('Fair', 15), { kind: 'free' });
eq('deriveGroup <5 routes', deriveGroup('Solid', 3), { kind: 'exact', n: 3 });
eq('deriveGroup discipline', deriveGroup('Underperforming', 3), { kind: 'reduced' });
ok('overlap Top+<5', hasTierOverlap('Top performer', 3));
ok('no overlap Top+15', !hasTierOverlap('Top performer', 15));

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
  advanced: {},
  priorWeekAvailable: false,
};
const { config, nameProblems } = assembleConfig(state);
eq('most_days', config.most_days, ['Daniel Lynch']);
eq('reduced names', config.reduced_days.names, ['Casey Church']);
eq('exact days', config.exact_days, { 'Joshua Workman': 3, 'Karl Berkley': 0 });
eq('waves schedule time', config.waves.Sun, { '10:25 AM': 4, '10:45 AM': 2 });
eq('exclude pruned to roster (Zackary not on roster -> dropped)', config.exclude, []);
eq('prev_week_file null', config.prev_week_file, null);
ok('no name problems', nameProblems.length === 0, JSON.stringify(nameProblems));

// ---- advanced overrides ----
const advCfg = assembleConfig({ ...state, advanced: {
  max_primary_days: 3, max_weekend_days: 1, merge_standing_unavailable: true, backup_eligible_extra: ['Casey Church'],
}, standing: { ...state.standing, hasPrefs: true } }).config;
eq('adv max_primary_days', advCfg.max_primary_days, 3);
eq('adv max_weekend_days emitted', advCfg.max_weekend_days, 1);
eq('adv merge_standing_unavailable', advCfg.merge_standing_unavailable, true);
eq('adv backup_eligible_extra', advCfg.backup_eligible_extra, ['Casey Church']);
eq('no weekend cap by default', config.max_weekend_days, undefined);

// ---- driver CSV ----
const csv = driverCsv({ drivers: [
  { name: 'Beta', cells: { Sun: '10:45 AM', Mon: 'Unavailable', Tue: '', Wed: '', Thu: '', Fri: '', Sat: '10:45 AM Backup' }, hours: 22 },
  { name: 'Alpha', cells: { Sun: '', Mon: '10:45 AM', Tue: '', Wed: '', Thu: '', Fri: '', Sat: '' }, hours: 40 },
] }, 'Week-40');
const csvLines = csv.trim().split('\n');
eq('csv header', csvLines[1], 'Driver,Sun,Mon,Tue,Wed,Thu,Fri,Sat,Total hours');
ok('csv sorted', csvLines[2].startsWith('Alpha'), csvLines[2]);

// ---- render ----
const passed = results.filter((r) => r.pass).length;
const total = results.length;
const el = document.getElementById('out');
el.innerHTML = `<div class="banner ${passed === total ? 'ok' : 'err'}"><b>${passed}/${total} passed</b></div>`
  + '<table><thead><tr><th></th><th>Test</th><th>Detail</th></tr></thead><tbody>'
  + results.map((r) => `<tr><td>${r.pass ? '✅' : '❌'}</td><td>${r.name}</td>`
    + `<td class="mono">${r.pass ? '' : (r.detail || '')}</td></tr>`).join('')
  + '</tbody></table>';

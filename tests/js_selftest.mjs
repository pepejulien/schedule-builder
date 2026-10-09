// Headless version of public/selftest.js — runs the pure front-end logic with
// no DOM so it can be executed in CI / locally under either runtime:
//   node tests/js_selftest.mjs
//   deno run tests/js_selftest.mjs
import { computeTiers } from '../public/app/lib/board-metrics.js';
import { normalizePortal, portalToSchedule, scheduleToPortal } from '../public/app/lib/waves.js';
import { norm, resolveFuzzy, matchName } from '../public/app/lib/names.js';
import { deriveGroup, hasTierOverlap, assembleConfig, trainerRotation, AUTO_TRAINER } from '../public/app/lib/config-assemble.js';
import { weekLabel, isSunday } from '../public/app/lib/weeks.js';
import { driverCsv } from '../public/app/lib/driver-csv.js';
import { readiness } from '../public/app/readiness.js';
import { joinChunks } from '../public/app/lib/board-fetch.js';
import { runRisk, riskCardHtml } from '../public/app/live/limits.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// waves
eq('portal 10:45 -> 10:25', portalToSchedule('10:45 AM'), '10:25 AM');
eq('portal 11:05 -> 10:45', portalToSchedule('11:05 AM'), '10:45 AM');
eq('normalize 10:45', normalizePortal('10:45 AM'), '10:45 AM');
eq('bad time null', portalToSchedule('nope'), null);
eq('schedule 10:25 -> portal 10:45', scheduleToPortal('10:25 AM'), '10:45 AM');
eq('schedule 11:05 -> portal 11:25', scheduleToPortal('11:05 AM'), '11:25 AM');

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

// Tier cutoffs, pinned exactly to the board's ladder (-3.5/-10/-25/-50).
// rateScore = -(sp/(routes+8)*100) and an oodt event adds mag/25 to sp, so with
// routes=92 the divisor is 100 and mag=25*x lands rateScore on exactly -x.
function rateDrv(x) {
  return { name: 'R', events: [{ track: 'oodt', d: D, mag: 25 * x }], strikes: [], backing: [0, 0], exp: [[D, 92, 3000]] };
}
const tierAt = (x) => computeTiers({ ...db, drivers: [rateDrv(x)] }, 30)[0].tier;
eq('rate -3.5 is Top', tierAt(3.5), 'Top performer');
eq('rate -3.6 drops to Solid', tierAt(3.6), 'Solid');
eq('rate -10 is Solid', tierAt(10), 'Solid');
eq('rate -10.1 drops to Fair', tierAt(10.1), 'Fair');
eq('rate -25 is Fair', tierAt(25), 'Fair');
eq('rate -25.1 drops to Underperforming', tierAt(25.1), 'Underperforming');
eq('rate -50 is Underperforming', tierAt(50), 'Underperforming');
eq('rate -50.1 drops to Termination review', tierAt(50.1), 'Termination review');

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

// trainer rotation: never-used first, then longest ago, then fewest, then marked order
const hist = { '2026-07-19': [['Aaron Bell', 'X', 'Sun']], '2026-07-26': [['Daniel Lynch', 'Y', 'Mon']],
  '2026-08-02': [['Casey Church', 'Z', 'Tue']] };
eq('rotation order', trainerRotation(['Daniel Lynch', 'Aaron Bell', 'Joshua Workman'], hist, '2026-09-01').map((x) => x.name),
  ['Joshua Workman', 'Aaron Bell', 'Daniel Lynch']);
eq('rotation ignores current week', trainerRotation(['Casey Church', 'Aaron Bell'], hist, '2026-08-02').map((x) => x.name),
  ['Casey Church', 'Aaron Bell']);
// auto pairs -> auto_training with a rotation-ordered pool (no trainee, no benched)
const autoState = { ...state, trainerHistory: hist,
  standing: { ...state.standing, bench: ['Karl Berkley'],
    trainers: ['Daniel Lynch', 'Aaron Bell', 'Karl Berkley', 'Joshua Workman'],
    trainingPairs: [{ trainer: AUTO_TRAINER, trainee: 'Joshua Workman' }] } };
const autoCfg = assembleConfig(autoState).config;
eq('auto pair not in training_pairs', autoCfg.training_pairs, []);
eq('auto_training pool', autoCfg.auto_training, [{ trainee: 'Joshua Workman', pool: ['Aaron Bell', 'Daniel Lynch'] }]);
eq('auto trainee gets exact 3', autoCfg.exact_days['Joshua Workman'], 3);
// a day target HR picked by hand beats the trainee default
const handState = { ...autoState, tierByDriver: { ...state.tierByDriver,
  'Joshua Workman': { ...state.tierByDriver['Joshua Workman'], groupValue: 'most', groupTouched: true } } };
ok('hand-picked target beats trainee pin', assembleConfig(handState).config.most_days.includes('Joshua Workman'));

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
eq('readiness has 5 steps', rd.steps.length, 5);
eq('readiness week & files warn (no prior week)', rd.steps[0].status, 'warn');
eq('readiness drivers done', rd.steps[1].status, 'done');
ok('readiness numbers.drivers', rd.numbers.drivers === 5, JSON.stringify(rd.numbers));
ok('readiness firstTodoIdx is a number', typeof rd.firstTodoIdx === 'number');

// board-fetch: the board splits its payload across column A, one cell per line.
eq('joinChunks single cell', joinChunks('"enc1:AAAA"'), { payload: 'enc1:AAAA', count: 1 });
eq('joinChunks stitches chunks', joinChunks('"enc1:AAAA"\n"BBBB"\n"CC=="'),
  { payload: 'enc1:AAAABBBBCC==', count: 3 });
eq('joinChunks skips blank rows', joinChunks('"enc1:AA"\n""\n\n"BB"'),
  { payload: 'enc1:AABB', count: 2 });
eq('joinChunks CRLF', joinChunks('"enc1:AA"\r\n"BB"'), { payload: 'enc1:AABB', count: 2 });
eq('joinChunks unescapes doubled quotes', joinChunks('"a""b"'), { payload: 'a"b', count: 1 });
eq('joinChunks unquoted cell', joinChunks('enc1:AAAA'), { payload: 'enc1:AAAA', count: 1 });

// limits.js runRisk (2026-10-08): the 'cap' fix's clock-out times cover backup days too
// ("if sent out"); a backup day never gets the "make it a backup" fix; route-only weeks unchanged.
{
  const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = DN.map((day, i) => ({ day, date: `2026-10-${11 + i}` }));
  const lim = { max_days_in_7: 5, max_7day_hours: 60, backup_hours: 2, max_day_hours: 12 };
  const mk = (cells) => { const dh = {}; for (const x of days) if (cells[x.day]) dh[x.date] = /Backup/.test(cells[x.day]) ? 2 : 10;
    return { name: 'Ana Test', cells, day_hours: dh }; };
  const six = (f) => Object.fromEntries(DN.slice(0, 6).map((d, i) => [d, f(i)]));
  const W = ['10:25 AM', '10:25 AM', '10:45 AM', '10:25 AM', '11:05 AM', '10:25 AM'];
  const cap = (r) => (r.fixes || []).find((f) => f.kind === 'cap');
  const BY = [1225, 1225, 1245, 1225, 1265, 1225];
  // route only: exactly what it gave before the change
  const r1 = runRisk(mk(six((i) => W[i])), days, '2026-10-08', lim);
  eq('runRisk routes: cap fix unchanged', cap(r1), { kind: 'cap', dates: days.slice(0, 6).map((x) => x.date), hours: 10,
    outs: days.slice(0, 6).map((x, i) => ({ date: x.date, by: BY[i] })), worst: 60 });
  eq('runRisk routes: a backup fix per route day', r1.fixes.filter((f) => f.kind === 'backup').length, 6);
  // backup on 6 days in 7: a cap fix whose outs are those backup days, with times and bk
  const r2 = runRisk(mk(six((i) => `${W[i]} Backup`)), days, '2026-10-08', lim);
  const c2 = cap(r2);
  ok('runRisk backups: cap fix', c2 && c2.hours === 10 && c2.outs.length === 6, JSON.stringify(r2.fixes));
  ok('runRisk backups: outs bk + clock-out', c2 && c2.outs.every((o, i) => o.bk === true && o.by === BY[i]), JSON.stringify(c2));
  eq('runRisk backups: no "make it a backup" fix', r2.fixes.filter((f) => f.kind === 'backup').length, 0);
  ok('riskCardHtml backups: clock-out shown', /sent out on a backup day.*clock out by <b>8:25 PM<\/b>/.test(riskCardHtml(mk(six((i) => `${W[i]} Backup`)), { run: r2 }, null, '')));
  // a mix: Tue + Thu backups, the rest routes
  const r3 = runRisk(mk(six((i) => (i === 2 || i === 4 ? `${W[i]} Backup` : W[i]))), days, '2026-10-08', lim);
  const c3 = cap(r3);
  ok('runRisk mix: cap counts all 6 days', c3 && c3.hours === 10 && c3.outs.length === 6 && c3.worst === 60, JSON.stringify(c3));
  eq('runRisk mix: bk only on the backup days', c3 && c3.outs.map((o) => !!o.bk), [false, false, true, false, true, false]);
  eq('runRisk mix: backup fixes only on route days', r3.fixes.filter((f) => f.kind === 'backup').map((f) => f.dates[0]),
    ['2026-10-11', '2026-10-12', '2026-10-14', '2026-10-16']);
  ok('riskCardHtml mix: backup day tagged', /Tue <i>\(backup, if sent out\)<\/i> clock out by <b>8:45 PM<\/b>/
    .test(riskCardHtml(mk(six((i) => (i === 2 || i === 4 ? `${W[i]} Backup` : W[i]))), { run: r3 }, null, '')));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) {
  console.log('FAILURES:'); fails.forEach((f) => console.log('  ✗', f));
  if (globalThis.Deno) globalThis.Deno.exit(1); else globalThis.process.exit(1);
}
console.log('ALL PASS');

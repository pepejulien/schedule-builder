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
import { runRisk, riskCardHtml, actualList, routeDays, backupDays, rtMismatches, missingDays, mergeActual, withConfirmed,
  overRisk, addUnscheduled, withOpenDays, openTodayRisk, roomOn, clockOutBy, doneDates } from '../public/app/live/limits.js';
import { actualSig, withRouteTracker, rtOnlyWeek, sharedTodayLines, actualLoadFailed } from '../public/app/live/live-model.js';

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

// Route Tracker backups / clock-in + "Route Tracker and the schedule don't match" (Jose 2026-10-08)
{
  const prev = { drivers: { k: { name: 'Kathy Deaton', keys: ['kathy|deaton'], days: {}, bk: { '2026-10-03': 2 }, start: { '2026-10-03': '10:25' } } } };
  const cur = { drivers: { k: { name: 'Kathy Deaton', keys: ['kathy|deaton'], days: { '2026-10-05': 9 }, bk: { '2026-10-07': 2 }, start: { '2026-10-05': '10:45' } } } };
  const L = actualList(prev, cur);
  eq('actualList merges bk', L[0].bk, { '2026-10-03': 2, '2026-10-07': 2 });
  eq('actualList merges start', L[0].start, { '2026-10-03': '10:25', '2026-10-05': '10:45' });
  eq('backupDays finds', backupDays(L)('Kathy Deaton'), { '2026-10-03': 2, '2026-10-07': 2 });
  eq('backupDays unknown -> null', backupDays(L)('Nobody Here'), null);
  eq('backupDays no bk -> null', backupDays([{ name: 'A B', keys: [], days: {} }])('A B'), null);

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = DAYS.map((day, i) => ({ day, date: `2026-10-${String(4 + i).padStart(2, '0')}` })); // Sun 10/4 .. Sat 10/10
  const W = '2026-10-07', T = '2026-10-08';  // Wed, Thu (today)
  const drv = (name, cells) => ({ name, cells });
  const rt = (name, o) => ({ name, keys: [], days: {}, ...o });
  const summary = { days, drivers: [
    drv('Kathy Deaton', { Wed: 'Unavailable' }),
    drv('Mo Mark', { Wed: 'Called out' }),
    drv('Tia Train', { Wed: '10:45 AM TRAIN helper (w/ X)', Thu: '10:45 AM TRAIN drives (w/ Y)' }),
    drv('Dee Disp', { Wed: 'Dispatch', Thu: '1:00 PM Meeting' }),
    drv('Rob Road', { Wed: '10:25 AM' }),
    drv('Ann Agree', { Wed: '10:25 AM Backup', Thu: '10:45 AM' }),
    drv('Sam Sent', { Wed: '10:25 AM Backup' }),
    drv('Bea Blank', {}),
    drv('Fut Ure', { Fri: 'Unavailable' }),
  ] };
  const list = [
    rt('Kathy Deaton', { bk: { [W]: 2 } }),
    rt('Mo Mark', { routes: { [W]: 'CX1' } }),
    rt('Tia Train', { bk: { [W]: 2 }, routes: { [T]: 'CX2' } }),
    rt('Dee Disp', { routes: { [W]: '' }, bk: { [T]: 2 } }),
    rt('Rob Road', { bk: { [W]: 2 } }),
    rt('Ann Agree', { bk: { [W]: 2 }, routes: { [T]: 'CX3' } }),
    rt('Sam Sent', { routes: { [W]: 'CX4' } }),
    rt('Bea Blank', { routes: { [W]: 'CX5' }, bk: { [T]: 2 } }),
    rt('Fut Ure', { routes: { '2026-10-09': 'CX6' } }),
    rt('Nora Nosched', { open: [T] }),
  ];
  const rows = rtMismatches(summary, list, T);
  eq('mismatch lines', rows.map((r) => r.line), [
    'Dee Disp · Wed 10/7 — Route Tracker has a route on a Dispatch day.',
    'Kathy Deaton · Wed 10/7 — Route Tracker has them as a backup, but the day is marked Unavailable.',
    'Mo Mark · Wed 10/7 — Route Tracker has them on a route, but the schedule says Called out.',
    'Rob Road · Wed 10/7 — scheduled for a route, Route Tracker has a backup (Amazon had fewer routes?).',
    'Tia Train · Wed 10/7 — Route Tracker has a backup on a training day.',
    'Dee Disp · Thu 10/8 — Route Tracker has a backup on a meeting day.',
    "Nora Nosched · Thu 10/8 — in Route Tracker but not on this week's schedule.",
  ]);
  eq('mismatch: open-day button only for schedule rows', rows.map((r) => r.onSchedule), [true, true, true, true, true, true, false]);
  eq('mismatch: day for setCell', rows[1].day, 'Wed');
  eq('mismatch: nothing without Route Tracker', rtMismatches(summary, [], T), []);
}

// Transporter ID match first, like runner._matcher (Jose 2026-10-08)
{
  const T = '2026-10-08';
  const days = [{ day: 'Sun', date: '2026-10-04' }, { day: 'Mon', date: '2026-10-05' }, { day: 'Tue', date: '2026-10-06' },
    { day: 'Wed', date: '2026-10-07' }, { day: 'Thu', date: '2026-10-08' }];
  const kathy = { name: 'Kathy Deaton', tid: 'T1', cells: { Mon: '10:25 AM', Tue: '10:25 AM', Wed: 'Unavailable' } };
  const other = { name: 'Zed Other', tid: '', cells: { Mon: '10:25 AM' } };
  const rt = [{ name: 'Kathryn Deaton', keys: ['kathryn|deaton'], tid: 'T1', days: { '2026-10-05': 10 },
    routes: { '2026-10-05': 'CX1' }, bk: { '2026-10-07': 2 } },
  { name: 'Zed Other', keys: ['zed|other'], tid: 'Z9', days: { '2026-10-05': 9, '2026-10-06': 9 } }];   // Tue tracked
  const summary = { days, drivers: [kathy, other], limits: {} };
  eq('tid: routeDays via driver', routeDays(rt)(kathy), { '2026-10-05': 'CX1' });
  eq('tid: routeDays via (name, tid)', routeDays(rt)('Kathy Deaton', 'T1'), { '2026-10-05': 'CX1' });
  eq('tid: routeDays plain name misses', routeDays(rt)('Kathy Deaton'), null);
  eq('tid: plain name still works', routeDays(rt)('Kathryn Deaton'), { '2026-10-05': 'CX1' });
  eq('tid: backupDays via driver', backupDays(rt)(kathy), { '2026-10-07': 2 });
  const miss = missingDays(summary, rt, {}, T);
  eq('tid: missingDays finds Kathy Tue', miss.map((m) => `${m.name}|${m.date}|${m.tid}`), ['Kathy Deaton|2026-10-06|T1']);
  const rows = rtMismatches(summary, rt, T);
  eq('tid: rtMismatches on schedule, no nosched row', rows.map((r) => `${r.name}|${r.date}|${r.kind}`), ['Kathy Deaton|2026-10-07|off']);
  eq('tid: mergeActual lays actual hours', mergeActual(summary, rt).drivers[0].day_hours['2026-10-05'], 10);
  const wc = withConfirmed(rt, [{ ...miss[0], answer: 'worked' }], {});
  eq('tid: withConfirmed folds into the tid entry', wc[0].days['2026-10-06'], 10);
  // a tid two Route Tracker entries share: never guessed, falls back to the name
  const shared = [{ name: 'Kathy Deaton', keys: [], tid: 'T1', routes: { '2026-10-05': 'A' } },
    { name: 'Kat Other', keys: [], tid: 'T1', routes: { '2026-10-05': 'B' } }];
  eq('tid: shared tid -> name', routeDays(shared)(kathy), { '2026-10-05': 'A' });
  eq('tid: shared tid, name differs -> null', routeDays(shared)({ name: 'Kathy Smith', tid: 'T1' }), null);
}

// Every Route Tracker driver gets the hours checks (2026-10-10): a stand-in row for anyone not on
// the schedule, and a route TODAY with no clock-out yet counts as still ahead (not "already worked").
{
  const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = DN.map((day, i) => ({ day, date: `2026-10-${String(4 + i).padStart(2, '0')}`, open: true })); // Sun 10/4 .. Sat 10/10
  const T = '2026-10-08';                                    // Thursday = today
  const lim = { max_7day_hours: 60, max_days_in_7: 5, backup_hours: 2, max_day_hours: 12, primary_hours: 10 };
  // 5 days, 51h (Fri + Sat last week, Sun-Tue this week), out on route CX9 today since 10:05, no clock-out
  const five = (extra = {}) => ({ '2026-10-02': 10.2, '2026-10-03': 10.2, ...extra });
  const prevDoc = { drivers: {
    u: { name: 'Uma Unsched', keys: ['uma|unsched'], tid: 'U1', days: five() },
    s: { name: 'Sam Sched', keys: ['sam|sched'], tid: 'S1', days: five() },
    o: { name: 'Old Only', keys: ['old|only'], tid: '', days: { '2026-10-02': 10 } },
  } };
  const wk = { '2026-10-04': 10.2, '2026-10-05': 10.2, '2026-10-06': 10.2 };
  const curDoc = { drivers: {
    u: { name: 'Uma Unsched', keys: ['uma|unsched'], tid: 'U1', days: { ...wk }, open: [T], routes: { [T]: 'CX9' }, start: { [T]: '10:05' } },
    s: { name: 'Sam Sched', keys: ['sam|sched'], tid: 'S1', days: { ...wk }, open: [T], routes: { [T]: 'CX8' }, start: { [T]: '10:05' } },
    // the same first|last key twice: "John Smith" on the schedule can't be told apart -> never guessed
    j1: { name: 'John Smith', keys: ['john|smith'], tid: '', days: { '2026-10-05': 11 }, open: [T] },
    j2: { name: 'Jon Smith', keys: ['jon|smith', 'john|smith'], tid: '', days: { '2026-10-06': 11 } },
  } };
  const sam = { name: 'Sam Sched', tid: 'S1', cls: 'top', cells: { Sun: '10:25 AM', Mon: '10:25 AM', Tue: '10:25 AM', Thu: '10:25 AM' },
    day_hours: { '2026-10-02': 10, '2026-10-03': 10, '2026-10-04': 10, '2026-10-05': 10, '2026-10-06': 10, [T]: 10 },
    worked_dates: ['2026-10-04', '2026-10-05', '2026-10-06', T], streak: 3 };
  const john = { name: 'John Smith', tid: '', cells: { Mon: '10:25 AM' }, day_hours: { '2026-10-05': 10 }, worked_dates: ['2026-10-05'] };
  const summary = { days, limits: lim, drivers: [sam, john] };
  const list = withConfirmed(actualList(prevDoc, curDoc), [], lim);

  // addUnscheduled: one stand-in (Uma); Sam is on the schedule, John's key is shared, Old Only didn't work this week
  const withU = addUnscheduled(summary, list, T);
  const uma = withU.drivers.find((d) => d.name === 'Uma Unsched');
  eq('unsched: one stand-in added', withU.drivers.map((d) => d.name), ['Sam Sched', 'John Smith', 'Uma Unsched']);
  ok('unsched: schedule drivers untouched', withU.drivers[0] === sam && withU.drivers[1] === john);
  eq('unsched: stand-in fields', uma && { ns: uma.notScheduled, cells: uma.cells, tid: uma.tid, max7: uma.max7, days7: uma.max_days7,
    week: uma.clock_hours, worked: uma.worked_dates, open: uma.open_dates, st: uma.rt_start },
  { ns: true, cells: {}, tid: 'U1', max7: 61, days7: 6, week: 40.6, worked: ['2026-10-04', '2026-10-05', '2026-10-06', T],
    open: [T], st: { [T]: '10:05' } });
  eq('unsched: open route day counts a full route', uma && uma.day_hours[T], 10);
  const hU = overRisk(uma, days, T, lim), rU = runRisk(uma, days, T, lim);
  ok('unsched: over 60h with today hot', hU && hU.hot.includes(T) && hU.over.some((w) => w.total === 61), JSON.stringify(hU && hU.hot));
  ok('unsched: 6 days in 7 with today hot', rU && rU.hot.includes(T), JSON.stringify(rU && rU.hot));
  eq('unsched: RTS + 6th day texts', openTodayRisk(uma, days, T, lim) && openTodayRisk(uma, days, T, lim).texts,
    ['RTS & clock out by 7:05 PM', '6th day in 7']);
  ok('unsched: card renders', /Uma Unsched goes over 60h in 7 days/.test(riskCardHtml(uma, { hours: hU, run: rU }, T, '')));
  ok('unsched: no Route Tracker -> summary as is', addUnscheduled(summary, [], T) === summary);
  ok('unsched: nobody new -> summary as is', addUnscheduled({ days, limits: lim, drivers: [sam] },
    list.filter((a) => a.name === 'Sam Sched'), T).drivers.length === 1);
  // a stand-in's clock-in unknown: the warning stays, the RTS time is left out
  const umaNoStart = { ...uma, rt_start: {} };
  // (2026-10-10) over/near with no clock-in: check by hand
  eq('unsched: no clock-in -> check by hand + 6th day', openTodayRisk(umaNoStart, days, T, lim).texts,
    ['near 60h - no start time, check by hand', '6th day in 7']);

  // the hot-day gap: Sam (on the schedule) is out on CX8 today with no clock-out
  const merged = mergeActual(summary, list).drivers[0];
  // mergeActual (what the Vehicle Assigner reads) carries the open day too: today shakes there as well
  eq('hot gap: mergeActual open_dates + clock-in', [merged.open_dates, merged.rt_start], [[T], { [T]: '10:05' }]);
  ok('hot gap: mergeActual -> today hot', merged.act_dates.includes(T) && overRisk(merged, days, T, lim).hot.includes(T)
    && runRisk(merged, days, T, lim).hot.includes(T));
  // without open_dates (as before): today counted as already worked
  const { open_dates: _o, ...mergedOld } = merged;
  ok('hot gap: no open_dates -> old behaviour', !(overRisk(mergedOld, days, T, lim) || { hot: [] }).hot.includes(T));
  const view = withRouteTracker(mergeActual(summary, list), list, T);
  const samV = view.drivers.find((d) => d.name === 'Sam Sched');
  eq('hot gap: withOpenDays marks today open', samV.open_dates, [T]);
  ok('hot gap: today shakes (60h)', overRisk(samV, days, T, lim).hot.includes(T));
  ok('hot gap: today shakes (6 days in 7)', runRisk(samV, days, T, lim).hot.includes(T));
  ok('hot gap: today not ✓ in the card', overRisk(samV, days, T, lim).breakdown.some((b) => b.date === T && !b.done && b.hot));
  eq('hot gap: Sam RTS + 6th day', openTodayRisk(samV, days, T, lim).texts, ['RTS & clock out by 7:05 PM', '6th day in 7']);
  eq('hot gap: stand-ins in the view too', view.drivers.filter((d) => d.notScheduled).map((d) => d.name), ['Uma Unsched']);
  // a day already finished (clock-out today) stays "already worked"
  const doneList = withConfirmed(actualList(prevDoc, { drivers: { s: { ...curDoc.drivers.s, days: { ...wk, [T]: 10.5 }, open: [] } } }), [], lim);
  const samDone = withRouteTracker(mergeActual(summary, doneList), doneList, T).drivers.find((d) => d.name === 'Sam Sched');
  ok('hot gap: clocked out today -> already worked, not hot', !samDone.open_dates
    && !overRisk(samDone, days, T, lim).hot.includes(T) && openTodayRisk(samDone, days, T, lim) === null);
  // an open day that's over (no out time entered yesterday) is not "today": it never shakes
  const yList = withConfirmed(actualList(prevDoc, { drivers: { s: { ...curDoc.drivers.s, open: ['2026-10-07'], start: {} } } }), [], lim);
  const samY = withOpenDays({ ...summary, drivers: [mergeActual(summary, yList).drivers[0]] }, yList).drivers[0];
  ok('hot gap: yesterday open stays worked', !runRisk(samY, days, T, lim) || !runRisk(samY, days, T, lim).hot.includes('2026-10-07'));
  // room under zero: no hours left today
  const tired = { ...samV, day_hours: { ...samV.day_hours, '2026-10-02': 15, '2026-10-03': 15, '2026-10-04': 15, '2026-10-05': 15 } };
  eq('hot gap: no hours left', openTodayRisk(tired, days, T, lim).texts[0], 'no hours left today');
}

// RTS whenever today's room is under the max day (2026-10-10) — the Vehicle Assigner / Route
// Tracker rule — even when nothing goes over 60h or 6 days in 7
{
  const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = DN.map((day, i) => ({ day, date: `2026-10-${String(4 + i).padStart(2, '0')}`, open: true }));
  const T = '2026-10-08';
  const lim = { max_7day_hours: 60, max_days_in_7: 5, backup_hours: 2, max_day_hours: 12, primary_hours: 10 };
  // used 49.5 in the 6 days before today (4 days), out today since 10:05: room 10.5
  const base = { name: 'Rita Room', cells: { Thu: '10:25 AM' }, open_dates: [T], rt_start: { [T]: '10:05' },
    day_hours: { '2026-10-04': 12.5, '2026-10-05': 12.5, '2026-10-06': 12.5, '2026-10-07': 12, [T]: 10 },
    worked_dates: ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', T], act_dates: ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', T] };
  eq('room: 49.5 used, 10.5 room', roomOn(base, T, lim), { room: 10.5, used: 49.5, max: 60 });
  ok('room: not over 60h, not 6 in 7', !overRisk(base, days, T, lim) && !runRisk(base, days, T, lim));
  const r = openTodayRisk(base, days, T, lim);
  const by = clockOutBy(605, 10.5).by;
  const hm = (x) => `${((Math.floor(x / 60) + 11) % 12) + 1}:${String(x % 60).padStart(2, '0')} ${x >= 720 ? 'PM' : 'AM'}`;
  ok('room 10.5: listed with by', r && r.by === by && r.near && !r.over && !r.six, JSON.stringify(r));
  eq('room 10.5: text', r && r.texts, [`RTS & clock out by ${hm(by)}`]);
  eq('room 10.5: by = 8:35 PM (10:05 + 10.5h + 30 min lunch - 30 min)', hm(by), '8:35 PM');
  // room 12 or more: nothing to tell
  const roomy = { ...base, day_hours: { '2026-10-04': 12, '2026-10-05': 12, '2026-10-06': 12, [T]: 10 } };
  ok('room 12+: room >= 12', roomOn(roomy, T, lim).room >= 12);
  // (2026-10-10) at 8 AM: the 12-hour day's RTS isn't due yet -> still nothing
  eq('room 12+: not listed', openTodayRisk(roomy, days, T, lim, new Date(`${T}T08:00:00`)), null);
  // no clock-in
  eq('room 10.5, no start: check by hand', openTodayRisk({ ...base, rt_start: {} }, days, T, lim).texts,
    ['near 60h - no start time, check by hand']);
  // not open today: nothing
  eq('room 10.5, clocked out: not listed', openTodayRisk({ ...base, open_dates: [] }, days, T, lim), null);
  // doneDates: open today is not done; other act_dates are
  eq('doneDates: open today removed', [...doneDates(base, T)].sort(), ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
  eq('doneDates: no open_dates -> act_dates', [...doneDates({ ...base, open_dates: [] }, T)].length, 5);
}

// a Route Tracker person sharing a key with a schedule driver: flagged, never guessed (2026-10-10)
{
  const T = '2026-10-08';
  const days = [{ day: 'Mon', date: '2026-10-05' }, { day: 'Tue', date: '2026-10-06' }, { day: 'Thu', date: T }];
  const john = { name: 'John Smith', tid: '', cells: { Mon: '10:25 AM' } };
  const list = [{ name: 'John Smith', keys: ['john|smith'], tid: '', days: { '2026-10-05': 11 }, routes: { '2026-10-05': 'CX1' } },
    { name: 'Jon Smith', keys: ['jon|smith', 'john|smith'], tid: '', days: {}, open: [T] }];
  const summary = { days, limits: {}, drivers: [john] };
  const rows = rtMismatches(summary, list, T);
  eq('shared: rows', rows.map((r) => `${r.name}|${r.date}|${r.kind}|${r.onSchedule}`),
    ['John Smith|2026-10-05|shared|false', 'Jon Smith|2026-10-08|shared|false']);
  eq('shared: text', rows[0] && rows[0].why, "can't tell which driver this is - check their hours by hand.");
  ok('shared: no stand-in', addUnscheduled(summary, list, T) === summary);
}

// ---- 2026-10-10 audit fixes (F9 meeting hours, F6 7th day, F2 12h day, F13 no schedule, F4 shared) ----
const DN10 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const days10 = DN10.map((day, i) => ({ day, date: `2026-10-${String(4 + i).padStart(2, '0')}`, open: true }));
const lim10 = { max_7day_hours: 60, max_days_in_7: 5, max_consecutive: 5, backup_hours: 2, max_day_hours: 12, primary_hours: 10 };
const hm10 = (x) => `${((Math.floor(x / 60) + 11) % 12) + 1}:${String(x % 60).padStart(2, '0')} ${x >= 720 ? 'PM' : 'AM'}`;

// F9: a meeting is 2h (backup_hours) and a day worked — like runner._day_hours / _worked_dates
{
  const T = '2026-10-08';
  const summary = { days: days10, limits: lim10,
    drivers: [{ name: 'Mia Meet', cells: { Tue: '1:00 PM Meeting', Wed: 'Meeting' }, day_hours: { '2026-10-06': 2, '2026-10-07': 2 },
      worked_dates: ['2026-10-06', '2026-10-07'] }] };
  // Route Tracker tracked Tue + Wed (someone else clocked out); Mia has no clock-out (meetings aren't in Route Tracker)
  const list = [{ name: 'Mia Meet', keys: [], tid: '', days: { '2026-10-05': 10 } },
    { name: 'Other Guy', keys: [], tid: '', days: { '2026-10-06': 10, '2026-10-07': 10 } }];
  const miss = missingDays(summary, list, {}, T);
  // #5 (2026-10-10): Route Tracker doesn't track meetings - never asked "what happened?"
  eq('meeting: not asked (Route Tracker does not track it)', miss, []);
  // no answer needed: the past meeting keeps 2h and is a worked day (not zeroed)
  const actC = withConfirmed(list, miss, lim10);
  const m = mergeActual(summary, actC).drivers[0];
  eq('meeting kept: day_hours 2', [m.day_hours['2026-10-06'], m.day_hours['2026-10-07']], [2, 2]);
  ok('meeting kept: worked days', m.worked_dates.includes('2026-10-06') && m.worked_dates.includes('2026-10-07'), JSON.stringify(m.worked_dates));
  ok('meeting kept: not an actual date', !m.act_dates.includes('2026-10-06'), JSON.stringify(m.act_dates));
  // runRisk counts meeting days as days worked: Sat-Mon routes + Tue/Wed meetings + Thu = 6 in 7
  const six = { name: 'Six Meet', cells: { Thu: '10:25 AM' }, day_hours: { '2026-10-03': 10, '2026-10-04': 10, '2026-10-05': 10, '2026-10-06': 2, '2026-10-07': 2, [T]: 10 },
    worked_dates: ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', T] };
  ok('meeting: runRisk counts it (6 in 7)', runRisk(six, days10, T, lim10) && runRisk(six, days10, T, lim10).hot.includes(T));
}

// F6: 7th day in a row -> cant, no RTS time
{
  const T = '2026-10-08';
  const d = { name: 'Seven Row', cells: { Thu: '10:25 AM' }, open_dates: [T], rt_start: { [T]: '10:05' },
    day_hours: { '2026-10-02': 9, '2026-10-03': 9, '2026-10-04': 9, '2026-10-05': 9, '2026-10-06': 9, '2026-10-07': 9, [T]: 10 },
    worked_dates: ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', T] };
  const r = openTodayRisk(d, days10, T, lim10, new Date(`${T}T11:00:00`));
  ok('7th day: cant', r && r.cant === true && r.inRow === 7, JSON.stringify(r));
  eq('7th day: text only', r && r.texts, ["can't work today - 7th day in a row"]);
  ok('7th day: no RTS time', r && r.by === null && r.day12 === null && !r.check && r.level === 'bad');
  // 6th day in a row: allowed, flagged, never cant
  const d6 = { ...d, day_hours: { '2026-10-03': 11, '2026-10-04': 11, '2026-10-05': 11, '2026-10-06': 11, '2026-10-07': 11, [T]: 10 } };
  const r6 = openTodayRisk(d6, days10, T, lim10, new Date(`${T}T11:00:00`));
  ok('6th day: not cant', r6 && !r6.cant && r6.inRow === 6, JSON.stringify(r6));
  ok('6th day: RTS line + 6th day text', r6 && r6.texts.some((t) => /^RTS & clock out by /.test(t)) && r6.texts.includes('6th day in 7'), JSON.stringify(r6 && r6.texts));
  // a gap breaks the run
  const gap = { ...d, day_hours: { ...d.day_hours, '2026-10-05': 0 }, worked_dates: ['2026-10-04', '2026-10-06', '2026-10-07', T] };
  ok('gap: not cant', !(openTodayRisk(gap, days10, T, lim10, new Date(`${T}T11:00:00`)) || {}).cant);
  // 6th day in 7 with lots of room: level warn (amber) - the only thing is the 6th day
  const light = { name: 'Light Six', cells: {}, open_dates: [T], rt_start: { [T]: '10:05' },
    day_hours: { '2026-10-03': 4, '2026-10-04': 4, '2026-10-05': 4, '2026-10-06': 4, '2026-10-07': 4, [T]: 10 },
    worked_dates: ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', T] };
  const rl = openTodayRisk(light, days10, T, lim10, new Date(`${T}T09:00:00`));
  ok('6th day only: level warn', rl && rl.level === 'warn' && !rl.cant, JSON.stringify(rl));
  eq('6th day only: text', rl && rl.texts, ['6th day in 7']);
}

// F2: the 12-hour day's RTS, only from an hour before it
{
  const T = '2026-10-08';
  const d = { name: 'Long Day', cells: { Thu: '10:25 AM' }, open_dates: [T], rt_start: { [T]: '10:05' },
    day_hours: { '2026-10-06': 10, '2026-10-07': 10, [T]: 10 }, worked_dates: ['2026-10-06', '2026-10-07', T] };
  ok('12h: room >= 12', roomOn(d, T, lim10).room >= 12);
  const by = clockOutBy(605, 12).by;   // 10:05 + 12.5h - 30 = 10:05 PM
  eq('12h: by = clock-in + 12.5h - 30', hm10(by), '10:05 PM');
  eq('12h: 9:04 PM -> nothing yet', openTodayRisk(d, days10, T, lim10, new Date(`${T}T21:04:00`)), null);
  const r = openTodayRisk(d, days10, T, lim10, new Date(`${T}T21:05:00`));
  eq('12h: 9:05 PM (by - 60) -> listed', r && r.texts, ['12-hour day - RTS & clock out by 10:05 PM']);
  // #13 (2026-10-10): an RTS time still ahead is amber ('warn'), past it red ('bad')
  ok('12h: day12 fields', r && r.day12 && r.day12.by === by && r.day12.limit === by + 30 && r.day12.due && r.level === 'warn' && !r.pastDue && r.by === null, JSON.stringify(r));
  const rp = openTodayRisk(d, days10, T, lim10, new Date(`${T}T22:06:00`));
  ok('12h: past the RTS time -> bad', rp && rp.pastDue && rp.level === 'bad', JSON.stringify(rp));
  // a Date or ms both work
  eq('12h: ms now', openTodayRisk(d, days10, T, lim10, new Date(`${T}T21:30:00`).getTime()).texts, ['12-hour day - RTS & clock out by 10:05 PM']);
  // no clock-in: no 12-hour line (nothing to time it from)
  eq('12h: no clock-in -> nothing', openTodayRisk({ ...d, rt_start: {} }, days10, T, lim10, new Date(`${T}T23:00:00`)), null);
}

// F13: no schedule for today's week -> Route Tracker drivers still get the checks
{
  const T = '2026-10-08';
  const list = actualList({ drivers: {
    a: { name: 'Rhea Tracker', keys: ['rhea|tracker'], tid: 'R1',
      days: { '2026-10-02': 9, '2026-10-03': 9, '2026-10-04': 9, '2026-10-05': 9, '2026-10-06': 9, '2026-10-07': 9 },
      open: [T], routes: { [T]: 'CX5' }, start: { [T]: '10:05' } },
    b: { name: 'Ned Nearly', keys: ['ned|nearly'], tid: '', days: { '2026-10-05': 12, '2026-10-06': 12, '2026-10-07': 12 },
      open: [T], routes: { [T]: 'CX6' }, start: { [T]: '10:05' } },
    c: { name: 'Off Today', keys: [], tid: '', days: { '2026-10-05': 10 } } } });
  const sm = rtOnlyWeek('2026-10-04', lim10, list, T);
  eq('no schedule: 7 days', sm.days.map((x) => x.date), days10.map((x) => x.date));
  eq('no schedule: stand-ins', sm.drivers.map((d) => `${d.name}|${d.notScheduled}`).sort(),
    ['Ned Nearly|true', 'Off Today|true', 'Rhea Tracker|true']);
  const rhea = sm.drivers.find((d) => d.name === 'Rhea Tracker');
  eq('no schedule: Rhea 7th day', openTodayRisk(rhea, sm.days, T, lim10, new Date(`${T}T11:00:00`)).texts, ["can't work today - 7th day in a row"]);
  const ned = sm.drivers.find((d) => d.name === 'Ned Nearly');
  eq('no schedule: Ned 36h -> room 24, nothing at 11 AM', openTodayRisk(ned, sm.days, T, lim10, new Date(`${T}T11:00:00`)), null);
  ok('no schedule: Off Today not out today', openTodayRisk(sm.drivers.find((d) => d.name === 'Off Today'), sm.days, T, lim10) === null);
  ok('no schedule: runRisk on Rhea', !!runRisk(rhea, sm.days, T, lim10));
  ok('no schedule: empty list -> no drivers', rtOnlyWeek('2026-10-04', lim10, [], T).drivers.length === 0);
  // actual_hours didn't load: both null, or no answer in 20 s
  ok('load: both null -> failed', actualLoadFailed({ cur: null, prev: null }, 0, 1000));
  ok('load: one doc -> fine', !actualLoadFailed({ cur: null, prev: { drivers: {} } }, 0, 1000));
  ok('load: waiting < 20 s -> fine', !actualLoadFailed({}, 0, 19000));
  ok('load: no answer after 20 s -> failed', actualLoadFailed({ cur: { drivers: {} } }, 0, 21000));
}

// F4: someone on a route today who can't be told apart from a schedule driver -> a Today line
{
  const T = '2026-10-08';
  const john = { name: 'John Smith', tid: '', cells: { Mon: '10:25 AM', Thu: '10:25 AM' } };
  const list = [{ name: 'John Smith', keys: ['john|smith'], tid: '', days: { '2026-10-05': 11 }, routes: { '2026-10-05': 'CX1', [T]: 'CX2' } },
    { name: 'Jon Smith', keys: ['jon|smith', 'john|smith'], tid: '', days: {}, open: [T], routes: { [T]: 'CX9' } }];
  const summary = { days: days10, limits: lim10, drivers: [john] };
  eq('shared today: lines', sharedTodayLines(summary, list, T).map((x) => x.line),
    ["Can't tell which driver John Smith (route CX2) is - check their hours by hand",
      "Can't tell which driver Jon Smith (route CX9) is - check their hours by hand"]);
  eq('shared: code on rtMismatches rows', rtMismatches(summary, list, T).filter((r) => r.date === T).map((r) => r.code), ['CX2', 'CX9']);
  // no route code yet
  const list2 = [list[0], { ...list[1], routes: {} }];
  eq('shared today: no code', sharedTodayLines(summary, list2, T).map((x) => x.line).filter((l) => /Jon/.test(l)),
    ["Can't tell which driver Jon Smith (on a route) is - check their hours by hand"]);
  eq('shared: not today -> no line', sharedTodayLines(summary, list, '2026-10-09').length, 0);
}

// ---- 2026-10-10 second audit: #4 TIDs separate people, #5 meeting/Dispatch kept, #6 open day max, #13 one colour rule ----
// #4: same first|last key but different Transporter IDs (both set) = two people, never matched
{
  const T = '2026-10-07';
  const b2 = { name: 'John Smith', keys: ['john|smith'], tid: 'B2', days: { '2026-10-05': 11, '2026-10-06': 11 }, open: [T], routes: { [T]: 'CX8' } };
  const a1 = { name: 'John Smith', tid: 'A1' };
  eq('tid4: A1 vs RT B2 only -> no match', routeDays([b2])(a1), null);
  eq('tid4: (name, tid) form too', routeDays([b2])('John Smith', 'A1'), null);
  eq('tid4: schedule without a TID still matches by name', routeDays([b2])('John Smith'), { [T]: 'CX8' });
  const blank = { ...b2, tid: '' };
  eq('tid4: RT entry without a TID matches A1 by name', routeDays([blank])(a1), { [T]: 'CX8' });
  // RT has B2 and a blank-TID John Smith: B2 is someone else, so the blank one is the only candidate
  eq('tid4: B2 ruled out, the blank one is it', routeDays([b2, { ...blank, routes: { [T]: 'CX1' } }])(a1), { [T]: 'CX1' });
  // no TID on the schedule side: two John Smiths can't be told apart
  eq('tid4: no schedule TID + 2 entries -> null', routeDays([b2, { ...blank, routes: { [T]: 'CX1' } }])('John Smith'), null);
  // RT has both A1 and B2: A1 by TID
  // (2026-10-10) with the schedule's people: a blank-TID entry both John Smiths would pick paints neither
  const twoJ = [{ name: 'John Smith', tid: 'A1' }, { name: 'John Smith', tid: 'C3' }];
  const sh = { ...blank, bk: { [T]: 2 } };
  eq('tid4: shared entry -> neither row (routes)', [routeDays([sh], twoJ)(twoJ[0]), routeDays([sh], twoJ)(twoJ[1])], [null, null]);
  eq('tid4: shared entry -> neither row (bk)', [backupDays([sh], twoJ)(twoJ[0]), backupDays([sh], twoJ)(twoJ[1])], [null, null]);
  eq('tid4: single John Smith still paints', routeDays([sh], [a1])(a1), { [T]: 'CX8' });
  eq('tid4: single John Smith bk', backupDays([sh], [a1])(a1), { [T]: 2 });
  eq('tid4: A1 found by TID among two', routeDays([b2, { ...b2, tid: 'A1', routes: { '2026-10-05': 'CX1' }, open: [] }])(a1), { '2026-10-05': 'CX1' });
  // the schedule's A1 is not merged with B2; B2 is "not on the schedule" (its own checks), not "can't tell"
  const summary = { days: days10, limits: lim10, drivers: [{ ...a1, cells: { Wed: '10:25 AM', Thu: '10:25 AM' }, day_hours: { [T]: 10, '2026-10-08': 10 }, worked_dates: [T, '2026-10-08'] }] };
  const m = mergeActual(summary, [b2]).drivers[0];
  eq('tid4: A1 keeps its schedule hours', m.day_hours, { [T]: 10, '2026-10-08': 10 });
  eq('tid4: B2 rows are nosched, not shared', rtMismatches(summary, [b2], T).map((r) => `${r.name}|${r.date}|${r.kind}`),
    ['John Smith|2026-10-07|nosched']);
  const u = addUnscheduled(summary, withConfirmed([b2], [], lim10), T);
  eq('tid4: B2 gets a stand-in row', u.drivers.map((d) => `${d.name}|${d.tid}|${!!d.notScheduled}`), ['John Smith|A1|false', 'John Smith|B2|true']);
  eq('tid4: no shared line today', sharedTodayLines(summary, [b2], T), []);
  // two blank-TID RT entries sharing the key next to the schedule's A1: still can't tell
  const two = [{ ...blank, routes: { [T]: 'CX1' } }, { ...blank, name: 'Jon Smith', keys: ['jon|smith', 'john|smith'] }];
  eq('tid4: blank TIDs still can not tell', sharedTodayLines(summary, two, T).length, 2);
}

// #5: a past meeting or Dispatch day without a Route Tracker clock-out keeps its scheduled hours
{
  const T = '2026-10-09';
  const old = { name: 'Dee Duty', tid: 'D1', cells: { Mon: '1:00 PM Meeting', Tue: 'Dispatch', Wed: '10:25 AM', Thu: '10:25 AM' },
    // a summary saved before the fix: the engine had zeroed both days
    day_hours: { '2026-10-05': 0, '2026-10-06': 0, '2026-10-07': 10, '2026-10-08': 10 }, worked_dates: ['2026-10-07', '2026-10-08'] };
  const summary = { days: days10, limits: lim10, drivers: [old] };
  const list = [{ name: 'Dee Duty', keys: [], tid: 'D1', days: { '2026-10-07': 10.5, '2026-10-08': 9 } },
    { name: 'Other Guy', keys: [], tid: 'O1', days: { '2026-10-05': 10, '2026-10-06': 10 } }];
  eq('duty: missingDays asks nothing', missingDays(summary, list, {}, T), []);
  const m = mergeActual(summary, withConfirmed(list, [], lim10)).drivers[0];
  eq('duty: meeting 2h, Dispatch 12h', [m.day_hours['2026-10-05'], m.day_hours['2026-10-06']], [2, 12]);
  eq('duty: worked days', m.worked_dates, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  eq('duty: clock hours', m.clock_hours, 2 + 12 + 10.5 + 9);
  eq('duty: streak 4', m.streak, 4);
  // a Route Tracker clock-out on the Dispatch day wins
  const m2 = mergeActual(summary, [{ ...list[0], days: { ...list[0].days, '2026-10-06': 11 } }, list[1]]).drivers[0];
  eq('duty: real clock-out wins', m2.day_hours['2026-10-06'], 11);
  // a scheduled route with no clock-out on a tracked day is still asked about
  const rd = { ...old, cells: { ...old.cells, Mon: '10:25 AM' } };
  eq('duty: a route day is still asked', missingDays({ ...summary, drivers: [rd] }, list, {}, T).map((x) => x.date), ['2026-10-05']);
}

// #6: an open day that already has hours (finished routes) counts the larger of the two
{
  const lst = (h) => [{ name: 'Olly Open', keys: [], tid: '', days: h == null ? {} : { '2026-10-08': h }, open: ['2026-10-08'] }];
  eq('open max: no hours -> full route', withConfirmed(lst(null), [], lim10)[0].days['2026-10-08'], 10);
  eq('open max: 4h finished -> full route', withConfirmed(lst(4), [], lim10)[0].days['2026-10-08'], 10);
  eq('open max: 11.5h finished -> 11.5', withConfirmed(lst(11.5), [], lim10)[0].days['2026-10-08'], 11.5);
  const u = addUnscheduled({ days: days10, limits: lim10, drivers: [] }, lst(11.5), '2026-10-08');
  eq('open max: stand-in keeps 11.5', u.drivers[0].day_hours['2026-10-08'], 11.5);
  const w = withOpenDays({ days: days10, limits: lim10, drivers: [{ name: 'Olly Open', day_hours: { '2026-10-08': 11.5 } }] }, lst(11.5));
  eq('open max: withOpenDays keeps 11.5', w.drivers[0].day_hours['2026-10-08'], 11.5);
}

// #13: one colour rule (Live board + Today): RTS time ahead / 6th day = amber, past due / none / can't time it = red
{
  const T = '2026-10-08';
  // 49.5h in the 6 days before (room 10.5), out since 10:05: RTS by 8:35 PM; a 10h route stays under 60h
  const base = { name: 'Rita Room', cells: { Thu: '10:25 AM' }, open_dates: [T], rt_start: { [T]: '10:05' },
    day_hours: { '2026-10-04': 12.5, '2026-10-05': 12.5, '2026-10-06': 12.5, '2026-10-07': 12, [T]: 10 },
    worked_dates: ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', T], act_dates: [] };
  const at = (hhmm, d = base) => openTodayRisk(d, days10, T, lim10, new Date(`${T}T${hhmm}:00`));
  const r = at('14:00');
  ok('colour: RTS time ahead -> warn', r && !r.over && r.by != null && r.level === 'warn' && !r.pastDue, JSON.stringify(r));
  // today's hours (11h finished) take them over 60h: red, even with the RTS time still ahead
  const ov = at('14:00', { ...base, day_hours: { ...base.day_hours, [T]: 11 } });
  ok('colour: over 60h with today counted -> bad', ov && ov.over && ov.level === 'bad', JSON.stringify(ov));
  const p = at('20:36');
  ok('colour: past the RTS time -> bad', p && p.pastDue && p.level === 'bad', JSON.stringify(p));
  const tired = { ...base, day_hours: { ...base.day_hours, '2026-10-07': 23 } };
  const n = at('11:00', tired);
  ok('colour: no hours left -> bad', n && n.none && n.level === 'bad', JSON.stringify(n));
  const nc = at('11:00', { ...base, rt_start: {} });
  ok('colour: no clock-in to time it -> bad', nc && nc.check && nc.level === 'bad', JSON.stringify(nc));
}

// #4b (2026-10-10): two schedule drivers share a key (each their own TID), one Route Tracker entry
// with NO TID has that key: it can't be tied to either - merged into neither, listed as "can't tell"
{
  const T = '2026-10-07';
  const a1 = { name: 'John Smith', tid: 'A1', cells: { Mon: '10:25 AM', Wed: '10:25 AM' }, day_hours: { '2026-10-05': 10, [T]: 10 }, worked_dates: ['2026-10-05', T] };
  const b2 = { name: 'John Smith', tid: 'B2', cells: { Tue: '10:25 AM', Wed: '10:25 AM' }, day_hours: { '2026-10-06': 10, [T]: 10 }, worked_dates: ['2026-10-06', T] };
  const rt = { name: 'John Smith', keys: ['john|smith'], tid: '', days: { '2026-10-05': 13, '2026-10-06': 13 }, open: [T], routes: { [T]: 'CX5' } };
  const summary = { days: days10, limits: lim10, drivers: [a1, b2] };
  const m = mergeActual(summary, [rt]);
  eq('amb2: A1 not merged', m.drivers[0].day_hours, a1.day_hours);
  eq('amb2: B2 not merged', m.drivers[1].day_hours, b2.day_hours);
  ok('amb2: no open_dates either', !m.drivers[0].open_dates && !m.drivers[1].open_dates);
  eq('amb2: rows are shared', rtMismatches(summary, [rt], T).map((r) => `${r.date}|${r.kind}`), ['2026-10-07|shared']);
  eq('amb2: Today line', sharedTodayLines(summary, [rt], T).map((x) => x.line),
    ["Can't tell which driver John Smith (route CX5) is - check their hours by hand"]);
  ok('amb2: no stand-in', addUnscheduled(summary, withConfirmed([rt], [], lim10), T) === summary);
  eq('amb2: missingDays asks nothing for them', missingDays(summary, [rt, { name: 'Other Guy', keys: [], tid: 'O1', days: { '2026-10-05': 9, '2026-10-06': 9 } }], {}, T), []);
  const w = withOpenDays(summary, [rt]);
  ok('amb2: withOpenDays leaves both alone', !w.drivers[0].open_dates && !w.drivers[1].open_dates);
  // the same entry WITH one of the TIDs: only that driver gets it
  const m2 = mergeActual(summary, [{ ...rt, tid: 'B2' }]);
  ok('amb2: TID set -> only B2', m2.drivers[0].day_hours['2026-10-05'] === 10 && m2.drivers[1].day_hours['2026-10-06'] === 13, JSON.stringify(m2.drivers.map((d) => d.day_hours)));
  // only one schedule John Smith: the TID-less entry still matches by name
  ok('amb2: one schedule driver -> matched', mergeActual({ ...summary, drivers: [a1] }, [rt]).drivers[0].day_hours['2026-10-05'] === 13);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) {
  console.log('FAILURES:'); fails.forEach((f) => console.log('  ✗', f));
  if (globalThis.Deno) globalThis.Deno.exit(1); else globalThis.process.exit(1);
}
console.log('ALL PASS');

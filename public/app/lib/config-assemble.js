// Assemble the solver config JSON from the wizard state, encoding the SKILL.md
// tier-policy ladder. This is the correctness heart of the app.
import { portalToSchedule } from './waves.js';
import { preflightNames, resolveFuzzy } from './names.js';

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DISCIPLINE = new Set(['Underperforming', 'Termination review']);
const MOST = new Set(['Top performer', 'Solid']);

// Default day-target group from a driver's board tier + 30-day route count.
// (SKILL.md "Tier-based day targets"). Returns a group descriptor.
export function deriveGroup(tier, routes) {
  if (DISCIPLINE.has(tier)) return { kind: 'reduced' };           // base 1, up to 2, Sun+Sat
  if (routes != null && routes < 5) return { kind: 'exact', n: 3 }; // pinned 3, never bumped
  if (MOST.has(tier)) return { kind: 'most' };                     // base 3, up to 4 road
  if (tier === 'Fair') return { kind: 'free' };                    // free pool: base 2, up to 4
  return { kind: 'exact', n: 3 };                                  // Unrated / unknown -> ask, default 3
}

// SKILL.md 2026-07-11: a driver matching two day-count categories (e.g. Top
// performer AND <5 routes) must be ruled on by a human before building.
export function hasTierOverlap(tier, routes) {
  return routes != null && routes < 5 && (MOST.has(tier) || tier === 'Fair');
}

export const GROUP_OPTIONS = [
  { value: 'most', label: 'Most days (Top/Solid: base 3, max 4)' },
  { value: 'free', label: 'Free pool (Fair: base 2, max 4 road, no backup)' },
  { value: 'reduced', label: 'Reduced (base 1, max 2, Sun+Sat)' },
  { value: 'exact:3', label: 'Exactly 3 days' },
  { value: 'exact:2', label: 'Exactly 2 days' },
  { value: 'exact:4', label: 'Exactly 4 days' },
  { value: 'bench', label: 'Bench (0 shifts, kept on sheet)' },
];

export function groupToValue(g) {
  if (g.kind === 'exact') return `exact:${g.n}`;
  return g.kind;
}
export function valueToGroup(v) {
  if (v.startsWith('exact:')) return { kind: 'exact', n: parseInt(v.split(':')[1], 10) };
  return { kind: v };
}

// Build waves for one day from its portal-time rows -> {scheduleTime: totalCount}.
function dayWaves(rows) {
  const out = {};
  for (const row of rows || []) {
    const n = parseInt(row.count, 10);
    if (!row.portalTime || !Number.isFinite(n) || n <= 0) continue;
    const sched = portalToSchedule(row.portalTime);
    if (!sched) continue;
    out[sched] = (out[sched] || 0) + n;
  }
  return out;
}

// state: {
//   week:{num, startISO}, availabilityRosterNames:[...],
//   tierByDriver:{ name:{tier, routes, rate, groupValue} },
//   demand:{ day:[{portalTime,count}] },
//   backups:{mode,pct,perDay},
//   standing:{exclude:[], bench:[], dispatch:{name:[days]}, trainingPairs:[{trainer,trainee}], hasPrefs},
//   advanced:{ free_primary_cap, max_primary_days, weekly_hours_cap, ... },
//   priorWeekAvailable:bool,
// }
export function assembleConfig(state) {
  const warnings = [];
  const roster = state.availabilityRosterNames || [];
  const tierByDriver = state.tierByDriver || {};
  const standing = state.standing || {};
  const adv = state.advanced || {};

  // --- waves + closed days ---
  const waves = {};
  for (const d of DAYS) {
    const w = dayWaves(state.demand?.[d]);
    if (Object.keys(w).length) waves[d] = w;
  }
  const closed = DAYS.filter((d) => !(d in waves));

  // Canonicalize a standing-config name to its unique roster spelling, or null
  // if it doesn't match this week's roster (departed drivers, management names
  // not on the sheet). This keeps strict_names from erroring on names the solver
  // can't resolve — matching SKILL.md's "prune names not on this week's roster".
  const canon = (name) => {
    const hits = resolveFuzzy(name, roster);
    return hits.length === 1 ? hits[0] : null;
  };
  const canonList = (arr) => [...new Set((arr || []).map(canon).filter(Boolean))];

  // --- per-driver day-target groups ---
  const trainingPairs = (standing.trainingPairs || [])
    .map((p) => ({ trainer: canon(p.trainer), trainee: canon(p.trainee) }))
    .filter((p) => p.trainer && p.trainee);
  const trainees = new Set(trainingPairs.map((p) => p.trainee));
  const bench = new Set(canonList(standing.bench));
  const exclude = new Set(canonList(standing.exclude));
  const dispatch = {};
  for (const [nm, days] of Object.entries(standing.dispatch || {})) {
    const c = canon(nm);
    if (c && Array.isArray(days) && days.length) dispatch[c] = days;
  }

  const most_days = [];
  const reducedNames = [];
  const exact_days = {};
  const driver_rates = {};

  for (const name of roster) {
    if (exclude.has(name)) continue;               // dropped from the sheet entirely
    const info = tierByDriver[name] || {};
    if (info.rate != null && Number.isFinite(info.rate)) driver_rates[name] = info.rate;

    // Resolve the effective group: bench list / trainee override win, else HR's
    // grid choice (which defaults to deriveGroup()).
    let g;
    if (bench.has(name)) g = { kind: 'exact', n: 0 };
    else if (trainees.has(name)) g = { kind: 'exact', n: 3 };
    else if (info.groupValue) g = valueToGroup(info.groupValue);
    else g = deriveGroup(info.tier, info.routes);

    if (g.kind === 'most') most_days.push(name);
    else if (g.kind === 'reduced') reducedNames.push(name);
    else if (g.kind === 'exact') exact_days[name] = g.n;
    else if (g.kind === 'bench') exact_days[name] = 0;
    // 'free' -> no entry (free pool)
  }

  // --- backup fallback ladder from tiers (Top, Solid, discipline last) ---
  const topNames = [], solidNames = [], discNames = [];
  for (const name of roster) {
    if (exclude.has(name)) continue;
    const t = tierByDriver[name]?.tier;
    if (t === 'Top performer') topNames.push(name);
    else if (t === 'Solid') solidNames.push(name);
    else if (DISCIPLINE.has(t)) discNames.push(name);
  }
  const backup_fallback = [topNames, solidNames, discNames].filter((g) => g.length);

  // --- backups ---
  let backupField;
  if (state.backups?.mode === 'perday') {
    backupField = { backup_per_day: {} };
    for (const d of Object.keys(waves)) backupField.backup_per_day[d] = Number(state.backups.perDay?.[d] || 0);
  } else {
    backupField = { backup_pct: Number(state.backups?.pct ?? 0.15) };
  }

  // --- config object ---
  const config = {
    week_label: state.week?.label || '',
    company: 'JAJB LOGISTICS LLC',
    station: 'WWV9',
    start_date: state.week?.startISO,
    closed_days: closed,
    max_consecutive: adv.max_consecutive ?? 5,
    primary_hours: adv.primary_hours ?? 10,
    backup_hours: adv.backup_hours ?? 2,
    free_primary_cap: adv.free_primary_cap ?? 4,
    max_primary_days: adv.max_primary_days ?? 4,
    weekly_hours_cap: adv.weekly_hours_cap ?? 40,
    max_total_days: adv.max_total_days ?? 5,
    free_total_days: adv.free_total_days ?? 4,
    waves,
    ...backupField,
    exclude: [...exclude],
    exact_days,
    reduced_days: { target: 2, names: reducedNames, prefer_days: ['Sun', 'Sat'] },
    most_days,
    driver_rates,
    use_premade_shifts: adv.use_premade_shifts ?? true,
    weekend_spread: adv.weekend_spread ?? true,
    training_pairs: trainingPairs,
    extra_worked_days: dispatch,
    backup_eligible_extra: canonList([
      ...(standing.backup_eligible_extra || []),
      ...(adv.backup_eligible_extra || []),
    ]),
    backup_fallback,
    strict_names: true,
    prev_week_file: state.priorWeekAvailable ? '/work/prev.xlsx' : null,
    prefs_csv: standing.hasPrefs ? '/work/prefs.csv' : null,
    avail_file: '/work/avail.xlsx',
    out: '/work/output.xlsx',
  };

  // Optional solver features — emit only when the per-week advanced panel turns
  // them on, so the config matches the solver's off-by-default behaviour.
  const wknCap = Number(adv.max_weekend_days);
  if (Number.isFinite(wknCap) && wknCap > 0) config.max_weekend_days = wknCap;
  if (adv.merge_standing_unavailable && config.prefs_csv) config.merge_standing_unavailable = true;

  // --- name pre-flight (mirror the solver's strict_names) ---
  const allNames = [
    ...config.exclude,
    ...Object.keys(config.exact_days),
    ...config.reduced_days.names,
    ...config.most_days,
    ...Object.keys(config.driver_rates),
    ...config.training_pairs.flatMap((p) => [p.trainer, p.trainee]),
    ...Object.keys(config.extra_worked_days),
    ...config.backup_fallback.flat(),
  ];
  const nameProblems = preflightNames([...new Set(allNames)], roster);

  return { config, warnings, nameProblems };
}

// Capacity sanity check (SKILL.md): can the fixed groups + free pool reach the
// week's route total? Returns { routeTotal, fixedRoad, freeMin, freeMax, ok, message }.
export function capacityCheck(config, rosterNames) {
  const routeTotal = Object.values(config.waves)
    .reduce((s, w) => s + Object.values(w).reduce((a, b) => a + b, 0), 0);
  const exclude = new Set(config.exclude);
  const most = new Set(config.most_days);
  const reduced = new Set(config.reduced_days.names);
  const exact = config.exact_days;

  const roadCap = config.max_primary_days || 4;
  // Max road-days each group can supply: Top/Solid & Fair up to the road cap (4),
  // discipline up to its target (2), explicit exacts at their value.
  let fixedRoad = 0;
  for (const n of most) fixedRoad += roadCap;
  for (const n of reduced) fixedRoad += config.reduced_days.target || 2;
  for (const [n, v] of Object.entries(exact)) fixedRoad += v;

  const assigned = new Set([...most, ...reduced, ...Object.keys(exact), ...exclude]);
  const freeCount = rosterNames.filter((n) => !assigned.has(n)).length;
  const freeMin = freeCount * 2;       // Fair target is 3, but 2 in a tight week
  const freeMax = freeCount * roadCap; // Fair can reach 4 when volume is high

  const reachable = fixedRoad + freeMax;
  const ok = reachable >= routeTotal;
  const message = ok
    ? `Top/Solid + Fair + discipline can supply up to ${reachable} road-days (Fair aims for 3). The week needs ${routeTotal} routes.`
    : `Even at full capacity the fleet can reach only ${reachable} road-days but the week needs ${routeTotal} — there aren't enough available drivers.`;
  return { routeTotal, fixedRoad, freeMin, freeMax, freeCount, ok, message };
}

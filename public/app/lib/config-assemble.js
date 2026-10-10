// Assemble the solver config JSON from the wizard state, encoding the SKILL.md
// tier-policy ladder. This is the correctness heart of the app.
import { portalToSchedule } from './waves.js';
import { preflightNames, resolveFuzzy, matchName } from './names.js';
import { normPref, weekUnavailable, onWeekendDays } from './driver-prefs.js';

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const PREFS_FAILED_MSG = "Couldn't read driver preferences — this build doesn't use them.";
export const TIMEOFF_FAILED_MSG = "Couldn't read the days off asked for this week — check the connection, then build again.";

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
  { value: 'free', label: 'Fair (base 2, max 4 road)' },
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

// A training pair whose trainer is AUTO_TRAINER lets the engine pick one of
// the marked trainers by rotation.
export const AUTO_TRAINER = '__auto__';

// Rotation order for the marked trainers: never-used first, then whoever
// trained longest ago, then fewest trainings, then the order they were marked.
// history = { weekStartISO: [[trainer, trainee, day], ...] }; the current
// week is ignored so rebuilding the same week doesn't reshuffle the line.
export function trainerRotation(trainers, history, currentWeekISO) {
  const last = {}, count = {};
  for (const [wk, rows] of Object.entries(history || {})) {
    if (wk === currentWeekISO || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const t = row && row[0];
      if (!t) continue;
      count[t] = (count[t] || 0) + 1;
      if (!last[t] || wk > last[t]) last[t] = wk;
    }
  }
  return (trainers || []).map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const la = last[a.t] || '', lb = last[b.t] || '';
      if (la !== lb) return la < lb ? -1 : 1;
      const ca = count[a.t] || 0, cb = count[b.t] || 0;
      if (ca !== cb) return ca - cb;
      return a.i - b.i;
    })
    .map((x) => ({ name: x.t, lastWeek: last[x.t] || null, times: count[x.t] || 0 }));
}

// "Copy Amazon's schedule exactly" needs a real schedule in the file: at least this many route shifts.
export const EXACT_MIN = 10;

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
//   standing:{exclude:[], bench:[], dispatch:{name:[days]}, trainers:[], trainingPairs:[{trainer|AUTO_TRAINER,trainee}], hasPrefs},
//   trainerHistory:{ weekStartISO:[[trainer, trainee, day]] },
//   advanced:{ free_primary_cap, max_primary_days, weekly_hours_cap, ... },
//   priorWeekAvailable:bool,
//   driverPrefs:{v:1, drivers:{name: Pref}} | null,      Drivers page (lib/driver-prefs.js)
//   weekTimeoff:{"<ISO>|<name>": {name, day, note}} | null, this week's requested days off
//   driverPrefsFailed:bool,                                 the prefs read failed: build without them
//   timeoffFailed:bool,                                     the time-off read failed: build without it
//   nameAliases:{ [normName]: rosterName },                 confirmed name matches (optional)
// }
export function assembleConfig(state) {
  const warnings = [];
  const roster = state.availabilityRosterNames || [];
  const tierByDriver = state.tierByDriver || {};
  const standing = state.standing || {};
  const adv = state.advanced || {};

  // --- waves + closed days ---
  const waves = {};
  const exactCopy = !!adv.exact_copy;
  const exactBk = {};
  if (exactCopy) {
    // "Copy Amazon's schedule exactly" (2026-10-07): the week's waves and backups are the ones
    // already in the uploaded sheet; the solver takes every shift as is (runner._force_exact).
    for (const dv of state.availabilityDrivers || []) for (const d of DAYS) {
      const t = String(dv.days?.[d]?.text || '');
      const m = t.match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
      if (!m || /unavail|meeting|dispatch|closed/i.test(t)) continue;
      if (/backup/i.test(t)) { exactBk[d] = (exactBk[d] || 0) + 1; continue; }
      if (/^helper/i.test(t.trim())) continue;
      const key = m[1].toUpperCase().replace(/\s+/, ' ').replace(/^0/, '');
      (waves[d] = waves[d] || {})[key] = (waves[d][key] || 0) + 1;
    }
  }
  // 2026-10-09: exact copy on, but the availability has no shifts in it (e.g. it came from Driver
  // preferences, or the export was swapped after "Copy exactly" was clicked) -> nothing to copy:
  // plan from the route counts like a normal build instead of an empty week. Same with only a stray
  // cell or two filled in (Jose's Week-42 export had 1): that's no schedule to copy.
  const copied = Object.values(waves).reduce((t, w) => t + Object.values(w).reduce((a, n) => a + n, 0), 0);
  const exactUsed = exactCopy && copied >= EXACT_MIN;
  if (exactCopy && !exactUsed) {
    warnings.push(`"Copy Amazon's schedule exactly" is on, but this week's availability has ${copied ? `only ${copied} route shift${copied === 1 ? '' : 's'}` : 'no shifts'} to copy — building from the route counts instead.`);
    for (const d of Object.keys(waves)) delete waves[d];
  }
  if (!exactUsed) {
    for (const d of DAYS) {
      const w = dayWaves(state.demand?.[d]);
      if (Object.keys(w).length) waves[d] = w;
    }
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
  const bench = new Set(canonList(standing.bench));
  const exclude = new Set(canonList(standing.exclude));
  const pairsIn = standing.trainingPairs || [];
  const trainingPairs = pairsIn
    .filter((p) => p.trainer !== AUTO_TRAINER)
    .map((p) => ({ trainer: canon(p.trainer), trainee: canon(p.trainee) }))
    .filter((p) => p.trainer && p.trainee);
  // Auto pairs: the engine picks from this week's marked trainers in rotation
  // order (benched / excluded trainers can't train).
  const pool = trainerRotation(canonList(standing.trainers), state.trainerHistory, state.week?.startISO)
    .map((x) => x.name).filter((n) => !bench.has(n) && !exclude.has(n));
  const auto_training = pairsIn
    .filter((p) => p.trainer === AUTO_TRAINER && canon(p.trainee))
    .map((p) => ({ trainee: canon(p.trainee), pool: pool.filter((n) => n !== canon(p.trainee)) }));
  for (const a of auto_training) {
    if (!a.pool.length) warnings.push(`No trainers are marked for this week's roster — ${a.trainee} won't get a training day. Mark trainers in Trainers & settings.`);
  }
  const trainees = new Set([...trainingPairs, ...auto_training].map((p) => p.trainee));
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

    // Resolve the effective group: bench list wins, then a day target HR picked
    // by hand, then the trainee default (3), else the grid's derived choice.
    let g;
    if (bench.has(name)) g = { kind: 'exact', n: 0 };
    else if (info.groupTouched && info.groupValue) g = valueToGroup(info.groupValue);
    else if (trainees.has(name)) g = { kind: 'exact', n: 3 };
    else if (info.groupValue) g = valueToGroup(info.groupValue);
    else g = deriveGroup(info.tier, info.routes);

    if (g.kind === 'most') most_days.push(name);
    else if (g.kind === 'reduced') reducedNames.push(name);
    else if (g.kind === 'exact') exact_days[name] = g.n;
    else if (g.kind === 'bench') exact_days[name] = 0;
    // 'free' -> no entry (free pool)
  }

  // --- board tier per driver: shown as a Tier column in the output workbook ---
  const driver_tiers = {};
  for (const name of roster) {
    if (exclude.has(name)) continue;
    const t = tierByDriver[name]?.tier;
    if (t) driver_tiers[name] = t;
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
    // A box HR never typed in shows the percent count (Step 3) — build with
    // that same number, not 0 (Jose 2026-10-06: per-day counts reset to zero).
    const pct = Number(state.backups.pct ?? 0.15);
    for (const d of Object.keys(waves)) {
      const v = state.backups.perDay?.[d];
      const routes = Object.values(waves[d]).reduce((s, n) => s + (Number(n) || 0), 0);
      backupField.backup_per_day[d] = (v === undefined || v === null || String(v).trim() === '')
        ? Math.round(routes * pct) : Number(v) || 0;
    }
  } else {
    backupField = { backup_pct: Number(state.backups?.pct ?? 0.15) };
  }

  // --- Driver preferences + requested days off (2026-10-09) ---
  // Names map to this week's roster spelling when they match one driver; the rest
  // go through as-is (the solver skips + lists them, never a strict_names error).
  const prefs = buildPrefKeys(state, roster, exclude, bench, closed);
  if (state.driverPrefsFailed) warnings.push(PREFS_FAILED_MSG);
  if (state.timeoffFailed) warnings.push(TIMEOFF_FAILED_MSG);

  // --- config object ---
  const config = {
    week_label: state.week?.label || '',
    company: 'JAJB LOGISTICS LLC',
    station: 'WWV9',
    start_date: state.week?.startISO,
    closed_days: closed,
    max_consecutive: adv.max_consecutive ?? 5,
    max_days_in_7: adv.max_days_in_7 ?? 5,
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
    driver_tiers,
    use_premade_shifts: adv.use_premade_shifts ?? true,
    ...(exactUsed ? { exact_copy: true, backup_per_day: exactBk, training_pairs: [], auto_training: false } : {}),
    weekend_spread: adv.weekend_spread ?? true,
    training_pairs: trainingPairs,
    auto_training,
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
  // Drivers-page keys: only when non-empty. NOT part of the name pre-flight below.
  for (const k of ['extra_unavailable', 'driver_max_days', 'driver_max_row', 'prefer_days', 'like_days']) {
    if (Object.keys(prefs[k]).length) config[k] = prefs[k];
  }
  if (prefs.keep_together.length) config.keep_together = prefs.keep_together;

  // --- name pre-flight (mirror the solver's strict_names) ---
  const allNames = [
    ...config.exclude,
    ...Object.keys(config.exact_days),
    ...config.reduced_days.names,
    ...config.most_days,
    ...Object.keys(config.driver_rates),
    ...config.training_pairs.flatMap((p) => [p.trainer, p.trainee]),
    ...config.auto_training.map((p) => p.trainee),
    ...Object.keys(config.extra_worked_days),
    ...config.backup_fallback.flat(),
  ];
  const nameProblems = preflightNames([...new Set(allNames)], roster);

  return { config, warnings, nameProblems, prefsInfo: prefs.info };
}

// The solver keys from the Drivers page + this week's time off, plus what the
// review card shows: info = { off: {name: {Day: {why, note?}}},
// limits: {name: {maxDays?, maxRow?, together?, weekend?: {on: [Day]}, likes?: [Day]}}, unmatched: [name] }
// like_days (very soft) leaves out closed days and the driver's days off this week.
// (unmatched = not on this week's roster; excluded / benched are left out).
// A failed read of one source still applies the other.
function buildPrefKeys(state, roster, exclude, bench, closed = []) {
  const out = { extra_unavailable: {}, driver_max_days: {}, driver_max_row: {}, keep_together: [],
    prefer_days: {}, like_days: {}, info: { off: {}, limits: {}, unmatched: [] } };
  const startISO = state.week?.startISO;
  const doc = state.driverPrefsFailed ? null : state.driverPrefs;
  const timeoff = state.timeoffFailed ? null : state.weekTimeoff;
  if (!startISO || (!doc && !timeoff)) return out;
  const aliases = state.nameAliases || {};
  const toRoster = (n) => matchName(n, roster, aliases).match || String(n).trim();
  const onRoster = new Set(roster);
  const unmatched = new Set();
  const take = (n) => {                     // roster name to use, or null to skip (excluded / benched)
    const r = toRoster(n);
    if (exclude.has(r) || bench.has(r)) return null;
    if (!onRoster.has(r)) unmatched.add(r);
    return r;
  };

  for (const [nm, days] of Object.entries(weekUnavailable(doc, timeoff, startISO))) {
    const r = take(nm);
    if (!r) continue;
    const eu = (out.extra_unavailable[r] = out.extra_unavailable[r] || {});
    const inf = (out.info.off[r] = out.info.off[r] || {});
    for (const [d, v] of Object.entries(days)) {
      if (eu[d] === 'timeoff' && v.why !== 'timeoff') continue;   // a requested day off wins
      eu[d] = v.why;
      inf[d] = v;
    }
  }
  const keep = new Set();
  for (const [nm, raw] of Object.entries((doc && doc.drivers) || {})) {
    const p = normPref(raw);
    if (!p) continue;
    const onW = onWeekendDays(p, startISO);
    const likeOpen = (p.likeDays || []).filter((d) => !closed.includes(d));
    if (!p.maxDays && !p.maxRow && !p.together && !p.weekends && !likeOpen.length) continue;
    const r = take(nm);
    if (!r) continue;
    const L = () => (out.info.limits[r] = out.info.limits[r] || {});
    const lim = (k, v) => {
      if (!v) return;
      out[k][r] = out[k][r] == null ? v : Math.min(out[k][r], v);
      L()[k === 'driver_max_days' ? 'maxDays' : 'maxRow'] = out[k][r];
    };
    lim('driver_max_days', p.maxDays);
    lim('driver_max_row', p.maxRow);
    if (p.together) { keep.add(r); L().together = true; }
    if (onW.length) out.prefer_days[r] = [...new Set([...(out.prefer_days[r] || []), ...onW])];
    if (p.weekends) L().weekend = { on: out.prefer_days[r] || [] };   // [] = off this weekend
    const like = likeOpen.filter((d) => !(out.extra_unavailable[r] && d in out.extra_unavailable[r]));
    if (like.length) {
      out.like_days[r] = DAYS.filter((d) => like.includes(d) || (out.like_days[r] || []).includes(d));
      L().likes = out.like_days[r];
    }
  }
  out.keep_together = [...keep];
  out.info.unmatched = [...unmatched].sort();
  return out;
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
  // Max road-days each group supplies under the NORMAL tier caps: Top/Solid &
  // Fair up to the road cap (4), discipline up to its target (2), exacts at
  // their pin.
  let fixedRoad = 0;
  let benched = 0;
  for (const n of most) fixedRoad += roadCap;
  for (const n of reduced) fixedRoad += config.reduced_days.target || 2;
  for (const [n, v] of Object.entries(exact)) { fixedRoad += v; if (!v) benched += 1; }

  const assigned = new Set([...most, ...reduced, ...Object.keys(exact), ...exclude]);
  const freeCount = rosterNames.filter((n) => !assigned.has(n)).length;
  const freeMin = freeCount * 2;       // Fair target is 3, but 2 in a tight week
  const freeMax = freeCount * roadCap; // Fair can reach 4 when volume is high

  const reachable = fixedRoad + freeMax;
  // Routes are the mission: when demand exceeds the normal caps, the engine
  // automatically relaxes the SOFT caps (discipline to 3 then 4 road days,
  // then exact pins) up to the hard ceiling of 4 road days per driver.
  const everyone = most.size + reduced.size + Object.keys(exact).length - benched + freeCount;
  const emergencyMax = everyone * roadCap;
  const ok = emergencyMax >= routeTotal;
  const message = reachable >= routeTotal
    ? `Top/Solid + Fair + discipline can supply up to ${reachable} road-days (Fair aims for 3). The week needs ${routeTotal} routes.`
    : ok
    ? `The week needs ${routeTotal} routes — above the normal tier caps (${reachable}). The engine will relax the soft caps (discipline to 3–4 days, then exact pins) to cover every route, up to ${emergencyMax}. The result page will list who got extra days.`
    : `Even with every soft cap relaxed the fleet can reach only ${emergencyMax} road-days but the week needs ${routeTotal} — there aren't enough available drivers.`;
  return { routeTotal, fixedRoad, freeMin, freeMax, freeCount, ok, message };
}

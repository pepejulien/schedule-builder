// Adapt the wizard store shape to the config assembler + gather solver inputs.
import { assembleConfig, capacityCheck } from './lib/config-assemble.js';

// drivers in the availability export who left the company (step-files addActive, 2026-11-22) are
// excluded from this build only — the saved standing settings stay as they are
function withLeftOut(standing, av) {
  const out = av && av.source !== 'live' ? (av.leftOut || []) : [];
  return out.length ? { ...standing, exclude: [...(standing.exclude || []), ...out] } : standing;
}

export function assembleFromWizard(w) {
  const state = {
    week: { num: w.week.num, startISO: w.week.startISO, label: w.week.label },
    availabilityRosterNames: w.availability?.rosterNames || [],
    availabilityDrivers: w.availability?.drivers || [],
    tierByDriver: w.tierByDriver || {},
    demand: w.demand || {},
    backups: w.backups || { mode: 'pct', pct: 0.15 },
    standing: withLeftOut(w.standing || {}, w.availability),
    // {name: last day} inside this week (card #1733): the days after it are hard days off
    leftAfter: (w.availability && w.availability.leftAfter) || {},
    trainerHistory: w.trainerHistory || {},
    advanced: w.advanced || {},
    priorWeekAvailable: !!(w.priorWeek && w.priorWeek.bytes),
    // Drivers page + requested days off (loaded by ensureDriverPrefs). Time off read for a
    // different week than the one being built is ignored.
    driverPrefs: w.driverPrefs || null,
    weekTimeoff: w.weekTimeoffISO && w.weekTimeoffISO === w.week.startISO ? (w.weekTimeoff || null) : null,
    driverPrefsFailed: !!w.driverPrefsFailed,
    timeoffFailed: !!w.timeoffFailed && w.weekTimeoffISO === w.week.startISO,
    // locked days (2026-11-20), same rule: only the ones read for this week
    weekLocks: w.weekLocksISO && w.weekLocksISO === w.week.startISO ? (w.weekLocks || null) : null,
    locksFailed: !!w.locksFailed && w.weekLocksISO === w.week.startISO,
    nameAliases: w.nameAliases || {},
  };
  const out = assembleConfig(state);
  // active drivers the availability export didn't have (step-files addActive, 2026-10-22)
  const extra = w.availability && w.availability.source !== 'live' ? (w.availability.extraDrivers || []) : [];
  if (extra.length && out.config) out.config.extra_drivers = extra.map((x) => ({ name: x.name, tid: x.tid, hire_date: x.hire_date }));
  out.capacity = capacityCheck(out.config, state.availabilityRosterNames);
  return out;
}

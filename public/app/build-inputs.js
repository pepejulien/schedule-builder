// Adapt the wizard store shape to the config assembler + gather solver inputs.
import { assembleConfig, capacityCheck } from './lib/config-assemble.js';

export function assembleFromWizard(w) {
  const state = {
    week: { num: w.week.num, startISO: w.week.startISO, label: w.week.label },
    availabilityRosterNames: w.availability?.rosterNames || [],
    availabilityDrivers: w.availability?.drivers || [],
    tierByDriver: w.tierByDriver || {},
    demand: w.demand || {},
    backups: w.backups || { mode: 'pct', pct: 0.15 },
    standing: w.standing || {},
    trainerHistory: w.trainerHistory || {},
    advanced: w.advanced || {},
    priorWeekAvailable: !!(w.priorWeek && w.priorWeek.bytes),
    // Drivers page + requested days off (loaded by ensureDriverPrefs). Time off read for a
    // different week than the one being built is ignored.
    driverPrefs: w.driverPrefs || null,
    weekTimeoff: w.weekTimeoffISO && w.weekTimeoffISO === w.week.startISO ? (w.weekTimeoff || null) : null,
    driverPrefsFailed: !!w.driverPrefsFailed,
    timeoffFailed: !!w.timeoffFailed && w.weekTimeoffISO === w.week.startISO,
    nameAliases: w.nameAliases || {},
  };
  const out = assembleConfig(state);
  out.capacity = capacityCheck(out.config, state.availabilityRosterNames);
  return out;
}

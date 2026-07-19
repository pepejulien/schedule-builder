// Adapt the wizard store shape to the config assembler + gather solver inputs.
import { assembleConfig, capacityCheck } from './lib/config-assemble.js';

export function assembleFromWizard(w) {
  const state = {
    week: { num: w.week.num, startISO: w.week.startISO, label: w.week.label },
    availabilityRosterNames: w.availability?.rosterNames || [],
    tierByDriver: w.tierByDriver || {},
    demand: w.demand || {},
    backups: w.backups || { mode: 'pct', pct: 0.15 },
    standing: w.standing || {},
    advanced: w.advanced || {},
    priorWeekAvailable: !!(w.priorWeek && w.priorWeek.bytes),
  };
  const out = assembleConfig(state);
  out.capacity = capacityCheck(out.config, state.availabilityRosterNames);
  return out;
}

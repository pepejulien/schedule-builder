// Compute an at-a-glance readiness picture of the current build from the wizard.
import { isSunday } from './lib/weeks.js';
import { DAYS } from './lib/waves.js';
import { assembleFromWizard } from './build-inputs.js';

export function readiness(wizard) {
  const w = wizard;
  const conflicts = Object.values(w.tierByDriver || {}).filter((r) => r && r.conflict).length;
  const operating = DAYS.filter((d) => (w.demand?.[d] || []).some((r) => (parseInt(r.count, 10) || 0) > 0));

  let nameProblems = [];
  let capacity = null;
  try {
    const out = assembleFromWizard(w);
    nameProblems = out.nameProblems || [];
    capacity = out.capacity || null;
  } catch { /* incomplete state */ }

  const step = (title, status, detail, idx) => ({ title, status, detail, idx });
  const steps = [
    step('Week', (w.week?.num && isSunday(w.week?.startISO)) ? 'done' : 'todo',
      w.week?.label || 'not set', 0),
    step('Availability', w.availability ? 'done' : 'todo',
      w.availability ? `${w.availability.counts.drivers} drivers` : 'no file uploaded', 1),
    step('Tiers & names', !w.tierMeta?.fetched ? 'todo' : (conflicts ? 'warn' : 'done'),
      !w.tierMeta?.fetched ? 'not fetched' : (conflicts ? `${conflicts} conflict(s) to resolve` : `as of ${w.tierMeta.asof || 'manual'}`), 2),
    step('Prior week', (w.priorWeek?.bytes || w.priorWeek?.source === 'none') ? (w.priorWeek?.source === 'none' ? 'warn' : 'done') : 'todo',
      w.priorWeek?.source === 'upload' ? (w.priorWeek.fileName || 'uploaded') : w.priorWeek?.source === 'none' ? 'none (first week)' : 'not set', 3),
    step('Route demand', operating.length ? 'done' : 'todo',
      operating.length ? `${operating.length} operating day(s)` : 'no routes entered', 4),
    step('Backups', operating.length ? 'done' : 'todo',
      w.backups?.mode === 'perday' ? 'per-day counts' : `${Math.round((w.backups?.pct ?? 0.15) * 100)}%`, 5),
    step('Standing settings', w.standing ? 'done' : 'todo', w.standing ? 'loaded' : 'not opened', 6),
    step('Review', nameProblems.length ? 'warn' : 'done',
      nameProblems.length ? `${nameProblems.length} name issue(s)` : 'ready', 7),
    step('Build', w.build?.status === 'done' ? 'done' : 'todo',
      w.build?.status === 'done' ? (w.build.report?.clean ? 'clean' : 'has warnings') : 'not built', 8),
  ];

  const warnings = [];
  if (conflicts) warnings.push(`${conflicts} tier conflict(s) still need a decision (Step 3).`);
  if (nameProblems.length) warnings.push(`${nameProblems.length} config name(s) don't match the roster (Step 3 / 7).`);
  if (w.priorWeek?.source === 'none') warnings.push('No prior week — the consecutive-day rule won\'t span the boundary.');
  if (capacity && !capacity.ok) warnings.push(capacity.message);

  const routeTotal = capacity ? capacity.routeTotal : 0;
  const numbers = {
    drivers: w.availability?.counts?.drivers || 0,
    operatingDays: operating.length,
    routeTotal,
    tiersAsOf: w.tierMeta?.asof || null,
  };

  // The first not-done step is where "Continue" should land.
  const firstTodo = steps.find((s) => s.status !== 'done');
  const doneCount = steps.filter((s) => s.status === 'done').length;

  return { steps, warnings, numbers, firstTodoIdx: firstTodo ? firstTodo.idx : 8, doneCount };
}

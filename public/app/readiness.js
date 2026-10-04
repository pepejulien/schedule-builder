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
  const weekOk = !!(w.week?.num && isSunday(w.week?.startISO));
  const priorOk = !!(w.priorWeek?.bytes || w.priorWeek?.source === 'none');
  const filesStatus = weekOk && w.availability && priorOk ? (w.priorWeek?.source === 'none' ? 'warn' : 'done') : 'todo';
  const filesDetail = !w.availability ? 'availability not uploaded'
    : !priorOk ? "last week's schedule not uploaded"
    : !weekOk ? 'week number / date not set'
    : `${w.week.label || 'week set'} · ${w.availability.counts.drivers} drivers`;
  const steps = [
    step('Week & files', filesStatus, filesDetail, 0),
    step('Drivers', !w.tierMeta?.fetched ? 'todo' : (conflicts ? 'warn' : 'done'),
      !w.tierMeta?.fetched ? 'tiers not loaded' : (conflicts ? `${conflicts} conflict(s) to resolve` : `board as of ${w.tierMeta.asof || 'manual entry'}`), 1),
    step('Routes & backups', operating.length ? 'done' : 'todo',
      operating.length ? `${operating.length} day(s) · backups ${w.backups?.mode === 'perday' ? 'per day' : `${Math.round((w.backups?.pct ?? 0.15) * 100)}%`}` : 'no routes entered', 2),
    step('Trainers & settings', w.standing ? (nameProblems.length ? 'warn' : 'done') : 'todo',
      !w.standing ? 'not opened yet' : nameProblems.length ? `${nameProblems.length} name issue(s)` : 'loaded', 3),
    step('Build', w.build?.status === 'done' ? 'done' : 'todo',
      w.build?.status === 'done' ? (w.build.report?.clean ? 'built — clean' : 'built — has warnings') : 'not built yet', 4),
  ];

  const warnings = [];
  if (conflicts) warnings.push(`${conflicts} tier conflict(s) still need a decision (Drivers).`);
  if (nameProblems.length) warnings.push(`${nameProblems.length} config name(s) don't match the roster (Drivers / Trainers & settings).`);
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

  return { steps, warnings, numbers, firstTodoIdx: firstTodo ? firstTodo.idx : 4, doneCount };
}

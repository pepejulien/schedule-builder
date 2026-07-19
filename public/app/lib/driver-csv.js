// Build a per-driver shift-notice CSV from the solver report's per-driver cells.
import { DAYS } from './waves.js';

function esc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// report.drivers[] each carry { name, cells:{day: text}, hours, cls }.
// Produces: Driver, Sun..Sat (assignment text), Total hours — sorted by name.
export function driverCsv(report, weekLabel) {
  const rows = (report.drivers || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const header = ['Driver', ...DAYS, 'Total hours'];
  const lines = [header.map(esc).join(',')];
  for (const d of rows) {
    const cells = d.cells || {};
    const line = [d.name, ...DAYS.map((day) => cells[day] || ''), `${d.hours}h`];
    lines.push(line.map(esc).join(','));
  }
  // A tiny title row up top for context (Excel-friendly).
  return (weekLabel ? esc(weekLabel) + '\n' : '') + lines.join('\n') + '\n';
}

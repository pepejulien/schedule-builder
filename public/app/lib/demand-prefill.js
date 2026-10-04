// Reconstruct per-day route demand from LAST week's schedule workbook, so
// Step 5 can start from a filled-in grid instead of a blank one.
//
// The workbook's shift cells carry SCHEDULE times ('10:25 AM', sometimes with
// a TRAIN note); demand is entered as PORTAL times (20 min later), so each
// counted time is shifted before it's returned. Backup and TRAIN-helper cells
// are not route slots and are skipped, as are Unavailable/Dispatch/Meeting
// (a meeting cell like '9:00 AM Safety Meeting' starts with a time too).
import * as XLSX from '../../vendor/xlsx.mjs';
import { DAYS, scheduleToPortal, parsePortalTime } from './waves.js';

export function demandFromPrevSchedule(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets['Shifts & Availability'] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The workbook has no readable sheet.');
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

  // Find the header row (the one naming the Associate column) and map each
  // day to its column — by header text, not position, like the solver does.
  let nameCol = -1;
  let headerRow = -1;
  let dayCols = {};
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const row = grid[r] || [];
    const nc = row.findIndex((v) => String(v || '').trim().toLowerCase().startsWith('associate'));
    if (nc === -1) continue;
    const dc = {};
    for (let c = 0; c < row.length; c++) {
      const m = String(row[c] || '').match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/);
      if (m) dc[c] = m[1];
    }
    if (Object.keys(dc).length === 7) {
      nameCol = nc; headerRow = r; dayCols = dc;
      break;
    }
  }
  if (headerRow === -1) throw new Error("Couldn't find the day columns in last week's schedule.");

  // Count route cells per (day, schedule time).
  const counts = {};                       // day -> {scheduleTime: n}
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const name = String(row[nameCol] || '').trim();
    if (!name || name.toLowerCase().startsWith('total')) continue;
    for (const [c, day] of Object.entries(dayCols)) {
      const v = String(row[c] || '').trim();
      const m = v.match(/^(\d{1,2}:\d{2}\s*[AP]M)/i);
      if (!m || /backup|TRAIN helper|meeting|dispatch|unavail/i.test(v)) continue;
      (counts[day] = counts[day] || {})[m[1].toUpperCase()] = (counts[day]?.[m[1].toUpperCase()] || 0) + 1;
    }
  }

  // -> the wizard's demand shape, in PORTAL times, waves sorted by time.
  const demand = {};
  for (const day of DAYS) {
    const byTime = counts[day];
    if (!byTime) continue;
    const rows = Object.entries(byTime)
      .map(([sched, n]) => ({ portalTime: scheduleToPortal(sched), count: String(n) }))
      .filter((r) => r.portalTime)
      .sort((a, b) => parsePortalTime(a.portalTime) - parsePortalTime(b.portalTime));
    if (rows.length) demand[day] = rows;
  }
  return demand;
}

// Tell the two weekly uploads apart so HR can drop both in one place:
//   * this week's "Shifts & Availability" export from the portal, and
//   * LAST week's schedule workbook this app built.
// Both share the portal layout, so the built schedule is recognized by what
// only the app writes: its 'By Day' / 'Training' sheets and the
// 'Total Scheduled' row. File names break any remaining tie.
// Also reads the week number / start Sunday when the file gives them away.
import * as XLSX from '../../vendor/xlsx.mjs';
import { parseAvailability } from './availability-parse.js';
import { toISODate } from './weeks.js';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// 'Sun, 02/Aug' (the portal's day header) -> the Date of that Sunday, picking
// the year that lands closest to today (the header carries no year).
function sundayFromHeader(text, today = new Date()) {
  const m = String(text || '').match(/^Sun\w*,?\s*(\d{1,2})\/([A-Za-z]{3})/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon == null) return null;
  let best = null;
  for (const y of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
    const d = new Date(y, mon, parseInt(m[1], 10));
    if (d.getDay() !== 0) continue;
    if (!best || Math.abs(d - today) < Math.abs(best - today)) best = d;
  }
  return best;
}

function weekNumFromName(name) {
  const m = String(name || '').match(/week[\s_-]*(\d{1,2})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// -> { kind: 'schedule'|'availability'|'unknown', score, weekNum, sundayISO,
//      parsed (availability parse, when readable), error }
// weekNum / sundayISO are for the week BEING BUILT (a last-week schedule is +1).
export function inspectWorkbook(bytes, fileName, today = new Date()) {
  let wb;
  try { wb = XLSX.read(bytes, { type: 'array' }); } catch {
    return { kind: 'unknown', error: `${fileName} could not be read as an .xlsx workbook.` };
  }
  const parsed = parseAvailability(bytes);
  if (parsed.error) return { kind: 'unknown', error: `${fileName}: ${parsed.error}` };

  const ws = wb.Sheets[parsed.sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  let hasTotals = false, sunday = null;
  for (const row of grid.slice(0, 8)) {
    for (const v of row) {
      const s = String(v || '').trim();
      if (/^total scheduled/i.test(s)) hasTotals = true;
      if (!sunday) sunday = sundayFromHeader(s, today);
    }
  }

  // + = looks like the app's own schedule output, - = looks like an export
  let score = 0;
  if (wb.SheetNames.includes('By Day')) score += 3;
  if (wb.SheetNames.includes('Training')) score += 2;
  if (hasTotals) score += 2;
  if (/schedule/i.test(fileName)) score += 1;
  if (/avail/i.test(fileName)) score -= 1;
  const kind = score > 0 ? 'schedule' : 'availability';

  let weekNum = weekNumFromName(fileName);
  if (kind === 'schedule' && weekNum != null) weekNum += 1;
  if (kind === 'schedule' && sunday) sunday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 7);
  return { kind, score, weekNum, sundayISO: sunday ? toISODate(sunday) : null, parsed };
}

// Two files dropped together that both scored the same kind: the higher
// score is the schedule. Returns [availability, schedule] (either may be null).
export function pairUp(items) {
  const ok = items.filter((x) => x.kind !== 'unknown');
  if (ok.length < 2) {
    const a = ok.find((x) => x.kind === 'availability') || null;
    const s = ok.find((x) => x.kind === 'schedule') || null;
    return [a, s];
  }
  const sorted = ok.slice().sort((x, y) => x.score - y.score);
  return [sorted[0], sorted[sorted.length - 1]];
}

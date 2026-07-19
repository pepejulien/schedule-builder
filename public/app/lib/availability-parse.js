// Parse the uploaded "Shifts & Availability" xlsx in the browser for the review
// grid and roster extraction. This is a faithful port of the solver's
// _layout()/load_roster() cell classification — but it is ADVISORY ONLY: the
// solver re-parses the same untouched file bytes authoritatively at build time.
import * as XLSX from '../../vendor/xlsx.mjs';

const DAY_RE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/;

function cell(grid, r, c) {
  const row = grid[r];
  if (!row) return '';
  const v = row[c];
  return v == null ? '' : String(v).trim();
}

// Returns { nameCol, dayCols: {day: col}, firstDataRow } or null.
function layout(grid) {
  const maxRow = Math.min(grid.length, 8);
  for (let r = 0; r < maxRow; r++) {
    const row = grid[r] || [];
    let nameCol = -1;
    for (let c = 0; c < row.length; c++) {
      if (String(row[c] || '').trim().toLowerCase().startsWith('associate')) { nameCol = c; break; }
    }
    if (nameCol < 0) continue;
    const dayCols = {};
    for (let c = 0; c < row.length; c++) {
      const m = DAY_RE.exec(String(row[c] || '').trim());
      if (m) dayCols[m[1]] = c;
    }
    if (Object.keys(dayCols).length === 7) {
      return { nameCol, dayCols, firstDataRow: r + 1 };
    }
  }
  return null;
}

function isDataName(v) {
  const s = String(v || '').trim();
  return !!s && !s.toLowerCase().startsWith('total');
}

// Classify one day cell -> 'unavail' | 'meeting' | 'seed' | '' (ignored/blank).
function classify(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const lv = s.toLowerCase();
  if (lv.includes('unavail')) return 'unavail';
  if (lv.includes('meeting')) return 'meeting';
  if (lv.includes('closed') || lv.includes('dispatch')) return '';
  return 'seed';
}

// Parse an ArrayBuffer -> { drivers: [{name, days:{day: {kind, text}}}], counts, error }.
export function parseAvailability(arrayBuffer) {
  let wb;
  try {
    wb = XLSX.read(arrayBuffer, { type: 'array' });
  } catch (e) {
    return { error: 'This file could not be read as an .xlsx workbook.' };
  }
  // Prefer the "Shifts & Availability" sheet; else the first sheet with a header.
  const sheetName = wb.SheetNames.includes('Shifts & Availability')
    ? 'Shifts & Availability'
    : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return { error: 'The workbook has no readable sheet.' };
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  const lay = layout(grid);
  if (!lay) {
    return { error: "This doesn't look like a Week-NN availability export "
      + '(no header row with an "Associate" column and 7 day columns).' };
  }
  const { nameCol, dayCols, firstDataRow } = lay;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const drivers = [];
  let nUnavail = 0, nSeed = 0, nMeeting = 0;
  for (let r = firstDataRow; r < grid.length; r++) {
    const raw = cell(grid, r, nameCol);
    if (!isDataName(raw)) continue;
    const name = raw.replace(/\s+/g, ' ').trim();
    const dayMap = {};
    for (const d of days) {
      const c = dayCols[d];
      const val = cell(grid, r, c);
      const kind = classify(val);
      dayMap[d] = { kind, text: val };
      if (kind === 'unavail') nUnavail++;
      else if (kind === 'seed') nSeed++;
      else if (kind === 'meeting') nMeeting++;
    }
    drivers.push({ name, days: dayMap });
  }
  if (!drivers.length) {
    return { error: 'No driver rows were found under the header.' };
  }
  return {
    sheetName,
    drivers,
    counts: { drivers: drivers.length, unavail: nUnavail, seed: nSeed, meeting: nMeeting },
  };
}

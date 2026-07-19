// Week-number <-> Sunday-date math and label formatting.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parse a 'YYYY-MM-DD' string as a LOCAL date (avoids UTC off-by-one).
export function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISODate(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isSunday(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  return parseISODate(iso).getDay() === 0; // 0 = Sunday
}

// The next Sunday on/after today (used as the default start date).
export function nextSunday(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const add = (7 - d.getDay()) % 7; // 0 if today is Sunday
  d.setDate(d.getDate() + (add === 0 ? 0 : add));
  return d;
}

export function addDays(dt, n) {
  const d = new Date(dt);
  d.setDate(d.getDate() + n);
  return d;
}

// "Week-40 (Aug 2 - Aug 8, 2026)" — ASCII hyphen (the solver asciizes anyway).
export function weekLabel(weekNum, startISO) {
  const start = parseISODate(startISO);
  const end = addDays(start, 6);
  const s = `${MONTHS[start.getMonth()]} ${start.getDate()}`;
  const e = `${MONTHS[end.getMonth()]} ${end.getDate()}`;
  return `Week-${weekNum} (${s} - ${e}, ${end.getFullYear()})`;
}

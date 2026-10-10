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

// The next Sunday AFTER today: the default week to build, since the schedule is
// made before its week starts (on a Sunday the week under way is already running).
export function nextSunday(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + (7 - d.getDay()));
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

// Amazon week number of the Sun..Sat week starting sundayISO: Week 1 is the week
// holding Jan 1 of the year its Saturday falls in (2026-10-04 -> 41). null if not a Sunday.
export function weekNumberOf(sundayISO) {
  if (!isSunday(sundayISO)) return null;
  const start = parseISODate(sundayISO);
  const jan1 = new Date(addDays(start, 6).getFullYear(), 0, 1);
  const week1 = addDays(jan1, -jan1.getDay());
  return Math.round((start - week1) / (7 * 86400000)) + 1;
}

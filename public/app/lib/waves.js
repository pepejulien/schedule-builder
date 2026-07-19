// Wave-time handling: HR enters PORTAL times; the solver needs SCHEDULE times,
// which are 20 minutes earlier (SKILL.md: "schedule time = portal block - 20 min").
// The -20 min conversion lives ONLY here so there is exactly one implementation.

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_FULL = {
  Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
  Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
};

// Parse "10:45 AM" / "10:45am" / "1045" -> minutes since midnight, or null.
export function parsePortalTime(s) {
  if (s == null) return null;
  const t = String(s).trim().toUpperCase().replace(/\s+/g, ' ');
  let m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) {
    const m2 = t.match(/^(\d{1,2})(\d{2})$/); // "1045"
    if (m2) m = [t, m2[1], m2[2], null];
    else return null;
  }
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3];
  if (min > 59) return null;
  if (ap === 'PM' && h < 12) h += 12;
  else if (ap === 'AM' && h === 12) h = 0;
  else if (!ap && h < 8) h += 12; // bare "1:05" for a delivery route -> PM-ish; DSP waves are late AM though
  if (h > 23) return null;
  return h * 60 + min;
}

// minutes -> "h:MM AM" (the exact format the solver's regex expects).
export function fmtTime(mins) {
  let h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

// Normalize a free-typed portal time to canonical "h:MM AM", or null if unparseable.
export function normalizePortal(s) {
  const mins = parsePortalTime(s);
  return mins == null ? null : fmtTime(mins);
}

// portal "h:MM AM" -> schedule "h:MM AM" (20 min earlier).
export function portalToSchedule(portalStr) {
  const mins = parsePortalTime(portalStr);
  if (mins == null) return null;
  return fmtTime((mins - 20 + 1440) % 1440);
}

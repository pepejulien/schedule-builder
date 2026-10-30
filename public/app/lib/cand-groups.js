// The orange "after a pop-up" candidates, split in two (Jose 2026-10-23): overtime
// first, then 6 days out of 7 — he'd rather give someone overtime than a 6th day.
// A driver with both lands in the 6-day group. The engine's status stays 'confirm'
// for both; only the lists group them apart.
export const isSixDay = (c) => (c.limits || c.reasons || []).some((x) => /^6-day:/.test(x));

// What a driver who asked for the day off would be without it (Jose 2026-10-29: no
// "day off" group at the bottom in red - they sit with everyone else, tagged
// Unavailable). The engine's reasons for 'unavail' are the day-off line, then the
// limits (overtime / 6-day), then the policy flags.
const offBase = (c) => {
  const rest = (c.reasons || []).slice(1);
  if ((c.limits || []).length || rest.some((x) => /^(6-day|overtime):/.test(x))) return 'confirm';
  return rest.length ? 'warn' : 'ok';
};

// The list group a candidate goes in: its status, or 'confirm6' for a 6-day; a day
// off goes where the rest of its rules put it (isOff() tags it).
export const candGroup = (c) => {
  const s = c.status === 'unavail' ? offBase(c) : c.status;
  return s === 'confirm' && isSixDay(c) ? 'confirm6' : s;
};

// The driver asked for this day off: an "Unavailable" tag by the name, and the
// pick still asks for the confirmation.
export const isOff = (c) => c.status === 'unavail';

// The CSS colour class of a group header and its rows ('six' is red: the bottom of the list).
export const groupClass = (g) => (g === 'confirm6' ? 'six' : g);

// The orange "after a pop-up" candidates, split in two (Jose 2026-10-23): overtime
// first, then 6 days out of 7 — he'd rather give someone overtime than a 6th day.
// A driver with both lands in the 6-day group. The engine's status stays 'confirm'
// for both; only the lists group them apart.
export const isSixDay = (c) => (c.limits || c.reasons || []).some((x) => /^6-day:/.test(x));

// The list group a candidate goes in: its status, or 'confirm6' for a 6-day.
export const candGroup = (c) => (c.status === 'confirm' && isSixDay(c) ? 'confirm6' : c.status);

// The CSS colour class of a group header ('confirm6' is orange like 'confirm').
export const groupClass = (g) => (g === 'confirm6' ? 'confirm' : g);

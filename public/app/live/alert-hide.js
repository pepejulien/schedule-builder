// Hide the Live board's two Route Tracker alert cards (Jose 2026-11-25, team idea): "Worked, but the
// out time is missing" (key 'worked') and "Route Tracker and the schedule don't match" (key 'rt').
// Only the owner and HR logins get the Hide button (api.js canHideAlerts). Display only: the rows
// and every answer stay as they are. Kept on this device per login and week (localStorage):
// {week: {worked: [row keys], rt: [row keys]}} — the rows the card showed when it was hidden.
// A row that isn't in that list (a new item) brings the card back; rows that went away don't.
const STORE = 'sb-live-hidden-alerts:';
const KEEP_WEEKS = 6;

// the row keys of each card, sorted
export const workedKeys = (missing) => [...new Set((missing || []).filter((m) => m.answer === 'worked')
  .map((m) => `${m.name}|${m.date}|worked`))].sort();
export const rtKeys = (rows) => [...new Set((rows || []).map((r) => `${r.name}|${r.date}|${r.kind}|${r.rt}`))].sort();

// still hidden: every row it shows now was there when it was hidden
export const stillHidden = (saved, keys) => Array.isArray(saved) && (keys || []).every((k) => saved.includes(k));

// saved = {worked?, rt?}; keys = {worked, rt} -> the hidden cards that stay hidden (a new row drops one)
export function pruneHidden(saved, keys) {
  const out = {};
  for (const [card, list] of Object.entries(saved || {})) if (stillHidden(list, keys[card] || [])) out[card] = list;
  return out;
}

function readAll(uid) {
  try { const v = JSON.parse(localStorage.getItem(STORE + uid) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export const loadHidden = (uid, week) => (uid ? readAll(uid)[week] || {} : {});
export function saveHidden(uid, week, cards) {
  if (!uid) return;
  const all = readAll(uid);
  if (Object.keys(cards || {}).length) all[week] = cards; else delete all[week];
  const weeks = Object.keys(all).sort().slice(-KEEP_WEEKS);   // old weeks drop off
  try { localStorage.setItem(STORE + uid, JSON.stringify(Object.fromEntries(weeks.map((w) => [w, all[w]])))); } catch { /* private window */ }
}

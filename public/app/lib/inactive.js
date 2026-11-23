// Drivers who have left (2026-11-22, card #1426) — ONE test for every screen that asks "is this person
// still with us?" (the Live board's rows, the weekly build's driver list; the time-off card should use it
// too). Inactive on a day = the cloud roster (Hub roster/<id>) has them status 'former' OR Amazon
// 'offboarded' OR an endDate before that day. The schedule can't read roster/* itself: it reads
// Firestore dispatch/lists (activeListOnce), whose `drivers` are exactly the status-active people Amazon
// hasn't offboarded (roster_sync.dispatch_list) — so "not on that list" covers former + offboarded — and
// whose driverInfo[name].endDate (when the Hub sends it) covers the last rule.
// Never a guess against someone: no list (not read / not readable) = nobody is inactive, and a name
// that matches anyone on the list by Transporter ID, exact name or first|last counts as on it.

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const flKey = (s) => { const t = fold(s).replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean); return t.length ? t[0] + '|' + t[t.length - 1] : ''; };

// active = activeListOnce()'s answer {drivers: [name], info: {name: {tid, hireDate, cert, endDate?}}} | null
// -> (name, tid, dateISO) => false | {why: 'roster' | 'end', endDate?}   (pure)
export function inactiveIndex(active) {
  if (!active || !Array.isArray(active.drivers) || !active.drivers.length) return () => false;
  const info = active.info && typeof active.info === 'object' ? active.info : {};
  const byName = new Map(), byFl = new Map(), byTid = new Map();
  for (const n of active.drivers) {
    const d = info[n] && typeof info[n] === 'object' ? info[n] : {};
    const end = /^\d{4}-\d{2}-\d{2}/.test(String(d.endDate || '')) ? String(d.endDate).slice(0, 10) : '';
    // two people sharing a first|last: the later end date (none = still here) wins
    const keep = (m, k) => { if (!k) return; const had = m.get(k); m.set(k, had === undefined ? end : !had || !end ? '' : had > end ? had : end); };
    keep(byName, fold(n));
    keep(byFl, flKey(n));
    if (d.tid) keep(byTid, String(d.tid).trim().toUpperCase());
  }
  return (name, tid, dateISO) => {
    const t = String(tid || '').trim().toUpperCase();
    const end = t && byTid.has(t) ? byTid.get(t) : byName.has(fold(name)) ? byName.get(fold(name)) : byFl.get(flKey(name));
    if (end === undefined) return { why: 'roster' };
    return end && dateISO && end < dateISO ? { why: 'end', endDate: end } : false;
  };
}

// The weekly build (Amazon's availability export): the names gone for the whole week — offboarded /
// former, or their end date before its Sunday. -> [name]   (pure)
export function goneForWeek(names, active, weekStartISO) {
  const gone = inactiveIndex(active);
  return (names || []).filter((n) => gone(n, '', weekStartISO));
}

// A day on the schedule that is real work to cover: a route, backup, training, dispatch or meeting.
// Empty, Unavailable and a call-out / no-show / day-off mark are not.
export function isWorkCell(v) {
  const s = String(v || '');
  return !!s && s !== 'Unavailable' && !/^(Called out|No-show|Day off)$/.test(s);
}

export const leftTip = (g) => (g && g.why === 'end' ? `Left the company (last day ${g.endDate}) — give this shift to someone else`
  : g && g.why === 'left' ? 'Left the company — give this shift to someone else'
  : 'No longer with us (Amazon offboarded or marked former on the roster) — give this shift to someone else');

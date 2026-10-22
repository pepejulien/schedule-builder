// Next week's availability without the portal export (Jose 2026-10-09): everyone working here
// now — the cloud's active list, the same one the dispatch report uses (loadDriverRoster with
// active: true; falls back to the newest published week plus Driver preferences when that list
// can't be read) — with the days they can't work that week (their preferences + the days off asked
// for on the board's future week).
//
// It is written as the same "Shifts & Availability" workbook the export is, so the rest of the
// build is unchanged — but every day cell stays BLANK: the build reads the preferences and days
// off fresh as extra_unavailable (with the reason: Asked off / Can't work / Off weekend), so a day
// off added after this step still counts. The days off here are only for the preview.
import * as XLSX from '../../vendor/xlsx.mjs';
import { DAYS } from './waves.js';
import { parseISODate, addDays, toISODate as toISO } from './weeks.js';
import { weekUnavailable, WHY_LABEL } from './driver-prefs.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fold = (s) => String(s || '').trim().toLowerCase();

// 'Sun, 11/Oct' — the portal's day header (file-detect reads the week back from it)
function dayHeader(weekStartISO, i) {
  const d = addDays(parseISODate(weekStartISO), i);
  return `${DAYS[i]}, ${String(d.getDate()).padStart(2, '0')}/${MONTHS[d.getMonth()]}`;
}

// roster [{name, tid?}], unavailable = weekUnavailable(...) ->
// { bytes, sheetName, drivers: [{name, days: {Day: {kind, text}}}], counts, rosterNames }
export function makeAvailability(roster, unavailable, weekStartISO) {
  const offBy = new Map(Object.entries(unavailable || {}).map(([n, days]) => [fold(n), days]));
  const seen = new Set();
  const people = [];
  for (const r of roster || []) {
    const name = String((r && r.name) || '').replace(/\s+/g, ' ').trim();
    if (!name || seen.has(fold(name))) continue;
    seen.add(fold(name));
    people.push({ name, tid: String((r && r.tid) || '').trim() });
  }
  people.sort((a, b) => a.name.localeCompare(b.name));

  const sheetName = 'Shifts & Availability';
  const rows = [['Associate', 'Transporter ID', ...DAYS.map((_, i) => dayHeader(weekStartISO, i))],
    ...people.map((p) => [p.name, p.tid, ...DAYS.map(() => '')])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const bytes = out instanceof ArrayBuffer ? out : new Uint8Array(out).buffer;

  let nUnavail = 0;
  const drivers = people.map((p) => {
    const off = offBy.get(fold(p.name)) || {};
    const days = {};
    for (const d of DAYS) {
      if (off[d]) { days[d] = { kind: 'unavail', text: WHY_LABEL[off[d].why] || 'Off' }; nUnavail++; }
      else days[d] = { kind: '', text: '' };
    }
    return { name: p.name, days };
  });
  return {
    bytes, sheetName, drivers, rosterNames: drivers.map((d) => d.name),
    counts: { drivers: drivers.length, unavail: nUnavail, seed: 0, meeting: 0 },
  };
}

// Read the roster, preferences and the week's days off, then make the workbook. Throws when the
// preferences or days off can't be read (better than a schedule that ignores them) or nobody's found.
// Also says where the names came from: fromActive (the active list was read), added (active, not
// on the newest published week or Driver preferences — new hires, or staff the export never had)
// and left (on those but not active any more — not scheduled).
export async function liveAvailability(weekStartISO) {
  const [{ loadDriverRoster, readDriverPrefs }, { timeoffOnce }] = await Promise.all([
    import('./driver-prefs.js'), import('../api.js')]);
  const [all, prefs, timeoff] = await Promise.all([
    loadDriverRoster({ active: true }), readDriverPrefs(), timeoffOnce(weekStartISO)]);
  if (!timeoff) throw new Error("couldn't read the days off asked for that week");
  const fromActive = all.some((r) => 'active' in r);
  const roster = fromActive ? all.filter((r) => r.active) : all;
  if (!roster.length) throw new Error('no drivers found');
  return {
    ...makeAvailability(roster, weekUnavailable(prefs, timeoff, weekStartISO), weekStartISO),
    fromActive,
    added: all.filter((r) => r.isNew).map((r) => r.name),
    left: fromActive ? all.filter((r) => !r.active).map((r) => r.name) : [],
  };
}

// The availability EXPORT path (Jose 2026-10-22: "the build gets every active driver"): the active
// drivers (role driver, dispatch/lists.driverInfo) the dropped file doesn't have — new hires Amazon
// hadn't listed yet. Same person = same first|last name. Hired after the week ends = not yet.
// -> [{name, tid, hire_date}] (pure; `active` = activeListOnce()'s answer)
export function missingActive(rosterNames, active, weekStartISO) {
  if (!active || !active.drivers) return [];
  const fl = (s) => { const t = String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
    return t.length ? t[0] + '|' + t[t.length - 1] : ''; };
  const have = new Set((rosterNames || []).map(fl));
  const info = active.info || {};
  const drivers = Object.keys(info).length ? active.drivers.filter((n) => info[n]) : active.drivers;
  const end = weekStartISO ? toISO(addDays(parseISODate(weekStartISO), 6)) : '';
  const out = [];
  for (const name of drivers) {
    const k = fl(name);
    if (!k || have.has(k)) continue;
    have.add(k);
    const i = info[name] || {};
    const hire = String(i.hireDate || '').slice(0, 10);
    if (end && hire && hire > end) continue;
    out.push({ name, tid: String(i.tid || ''), hire_date: hire });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The availability with those drivers added as rows (no days off; days before the hire date shown
// "Not hired yet" — the build does the same from extra_drivers). -> a new availability object
export function withExtraDrivers(avail, extra, weekStartISO) {
  const start = weekStartISO ? parseISODate(weekStartISO) : null;
  const rows = (extra || []).map((x) => {
    const days = {};
    DAYS.forEach((d, i) => {
      const before = start && x.hire_date && toISO(addDays(start, i)) < x.hire_date;
      days[d] = before ? { kind: 'unavail', text: 'Not hired yet' } : { kind: '', text: '' };
    });
    return { name: x.name, days, added: true };
  });
  const drivers = [...(avail.drivers || []).filter((d) => !d.added), ...rows];
  return { ...avail, extraDrivers: extra || [], drivers, rosterNames: drivers.map((d) => d.name),
    counts: { ...avail.counts, drivers: drivers.length } };
}

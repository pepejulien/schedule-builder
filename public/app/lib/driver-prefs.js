// Driver preferences + requested days off (2026-10-09) — the shared contract the Drivers page,
// the Live board and the weekly builder all read. Pure helpers at the top; the few that touch
// storage import api.js lazily, so this file loads under plain node for the tests.
//
// Stored doc (settings key standing/drivers.json = Firestore schedule/drivers):
//   { v: 1, drivers: { [driverName]: Pref } }
// Pref = {
//   days?: ['Sun', ...]   days of the week they CAN work; absent, empty or all 7 = any day
//   maxDays?: 1..6        most days on the clock a week (route, backup, any shift)
//   maxRow?: 1..5         most days in a row (1 = every other day, 2 = 2 on 1 off)
//   together?: true       soft: keep their days next to each other
//   weekends?: { mode: 'alternate', on: 'YYYY-MM-DD' }   `on` = a Saturday of one of their ON weekends
//   likeDays?: ['Mon', ...]   very soft: days they'd LIKE to work (only days inside `days`; all 7 = no
//                             preference, so dropped). A light placement nudge only; every other rule wins.
//   note?: string
//   by?: string, at?: ISO string   who/when last changed (set by saveDriverPref)
// }
// Requested days off come from api.watchTimeoff: {"<ISO day>|<name>": {name, day, note, by, at}}.
import { DAYS } from './waves.js';
import { parseISODate, toISODate, addDays } from './weeks.js';

export const PREFS_KEY = 'standing/drivers.json';
export const WHY_LABEL = { timeoff: 'Asked off', days: "Can't work", weekend: 'Off weekend' };

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isISO = (s) => typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(parseISODate(s).getTime());
const shift = (iso, n) => toISODate(addDays(parseISODate(iso), n));
const fold = (s) => String(s || '').trim().toLowerCase();
const clampInt = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n) ? null : Math.min(hi, Math.max(lo, n));
};
// the Saturday a date's weekend belongs to: a Sunday goes with the Saturday before it
const satOf = (iso) => {
  const d = parseISODate(iso).getDay();
  return shift(iso, d === 0 ? -1 : 6 - d);
};

// A cleaned copy: bad or empty fields dropped, numbers clamped, days in Sun..Sat order (all 7 =
// no limit, so dropped). null when nothing is left (by/at alone don't count).
export function normPref(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  if (Array.isArray(p.days)) {
    const set = new Set(p.days.map((d) => String(d).trim().slice(0, 3).toLowerCase()));
    const days = DAYS.filter((d) => set.has(d.toLowerCase()));
    if (days.length > 0 && days.length < 7) out.days = days;
  }
  const md = clampInt(p.maxDays, 1, 6);
  if (md != null) out.maxDays = md;
  const mr = clampInt(p.maxRow, 1, 5);
  if (mr != null) out.maxRow = mr;
  if (p.together === true) out.together = true;
  const w = p.weekends;
  if (w && typeof w === 'object' && w.mode === 'alternate' && isISO(w.on)) {
    out.weekends = { mode: 'alternate', on: satOf(w.on) };   // a non-Saturday snaps to its weekend's Saturday
  }
  if (Array.isArray(p.likeDays)) {
    const set = new Set(p.likeDays.map((d) => String(d).trim().slice(0, 3).toLowerCase()));
    const like = DAYS.filter((d) => set.has(d.toLowerCase()) && (!out.days || out.days.includes(d)));
    if (like.length > 0 && like.length < 7) out.likeDays = like;
  }
  const note = typeof p.note === 'string' ? p.note.trim().slice(0, 300) : '';
  if (note) out.note = note;
  if (!Object.keys(out).length) return null;
  if (typeof p.by === 'string' && p.by) out.by = p.by;
  if (typeof p.at === 'string' && p.at) out.at = p.at;
  return out;
}

// Is the weekend whose Saturday is satISO one of their ON weekends? null = no weekend rule.
// Alternates every 7 days from pref.weekends.on, both forward and back.
export function weekendOn(pref, satISO) {
  const w = pref && pref.weekends;
  if (!w || w.mode !== 'alternate' || !isISO(w.on) || !isISO(satISO)) return null;
  const diff = Math.round((parseISODate(satOf(satISO)) - parseISODate(satOf(w.on))) / 86400000);
  const k = Math.round(diff / 7);
  return ((k % 2) + 2) % 2 === 0;
}

// Days of the Sun..Sat week starting weekStartISO they can't work, from their preferences:
// {Day: 'days' | 'weekend'}. Sat goes with this week's weekend; Sun with the weekend whose Saturday
// is the day before it. 'days' wins when both apply.
export function prefOffDays(pref, weekStartISO) {
  const p = normPref(pref);
  const out = {};
  if (!p || !isISO(weekStartISO)) return out;
  if (p.days) for (const d of DAYS) if (!p.days.includes(d)) out[d] = 'days';
  if (!out.Sun && weekendOn(p, shift(weekStartISO, -1)) === false) out.Sun = 'weekend';
  if (!out.Sat && weekendOn(p, shift(weekStartISO, 6)) === false) out.Sat = 'weekend';
  return out;
}

// ['Sun'?, 'Sat'?]: the days of this week inside one of their ON weekends (empty with no rule).
export function onWeekendDays(pref, weekStartISO) {
  const p = normPref(pref);
  if (!p || !isISO(weekStartISO)) return [];
  const out = [];
  if (weekendOn(p, shift(weekStartISO, -1)) === true) out.push('Sun');
  if (weekendOn(p, shift(weekStartISO, 6)) === true) out.push('Sat');
  return out;
}

// Everyone's unavailable days for one week:
//   { [name]: { [Day]: { why: 'timeoff' | 'days' | 'weekend', note? } } }
// A requested day off wins over a preference. Names match case-insensitively (the first spelling seen is kept).
export function weekUnavailable(prefsDoc, timeoff, weekStartISO) {
  const out = {};
  if (!isISO(weekStartISO)) return out;
  const keyOf = new Map();        // folded name -> the key used in out
  const slot = (name) => {
    const f = fold(name);
    if (!keyOf.has(f)) { keyOf.set(f, String(name).trim()); out[String(name).trim()] = {}; }
    return out[keyOf.get(f)];
  };
  for (const [name, pref] of Object.entries((prefsDoc && prefsDoc.drivers) || {})) {
    const off = prefOffDays(pref, weekStartISO);
    if (!Object.keys(off).length) continue;
    const s = slot(name);
    for (const [d, why] of Object.entries(off)) s[d] = { why };
  }
  const end = shift(weekStartISO, 6);
  for (const t of Object.values(timeoff || {})) {
    if (!t || !t.name || !isISO(t.day) || t.day < weekStartISO || t.day > end) continue;
    const note = typeof t.note === 'string' ? t.note.trim() : '';
    slot(t.name)[DAYS[parseISODate(t.day).getDay()]] = note ? { why: 'timeoff', note } : { why: 'timeoff' };
  }
  for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
  return out;
}

// Short plain-English chips for a preference, e.g. ['Mon–Fri only', '4 days max', 'Every other weekend'].
export function prefSummary(pref) {
  const p = normPref(pref);
  if (!p) return [];
  const out = [];
  if (p.days) {
    const idx = p.days.map((d) => DAYS.indexOf(d));
    const run = idx[idx.length - 1] - idx[0] + 1 === idx.length;
    const missing = DAYS.filter((d) => !p.days.includes(d));
    if (p.days.length === 1) out.push(`${p.days[0]} only`);
    else if (missing.length === 1) out.push(`No ${missing[0]}`);
    else if (run && p.days.length >= 3) out.push(`${p.days[0]}–${p.days[p.days.length - 1]} only`);
    else if (missing.length <= p.days.length) out.push(`No ${missing.join(', ')}`);
    else out.push(`${p.days.join(', ')} only`);
  }
  if (p.maxDays) out.push(`${p.maxDays} day${p.maxDays === 1 ? '' : 's'} max`);
  if (p.maxRow) out.push(`${p.maxRow} in a row max`);
  if (p.together) out.push('Days together');
  if (p.weekends) out.push('Every other weekend');
  if (p.likeDays) {
    const idx = p.likeDays.map((d) => DAYS.indexOf(d));
    const run = idx[idx.length - 1] - idx[0] + 1 === idx.length;
    out.push(run && p.likeDays.length >= 3
      ? `Likes ${p.likeDays[0]}–${p.likeDays[p.likeDays.length - 1]}`
      : `Likes ${p.likeDays.join(', ')}`);
  }
  return out;
}

// ---------------------------------------------------------------- storage --
const emptyDoc = () => ({ v: 1, drivers: {} });
function cleanDoc(d) {
  const out = emptyDoc();
  if (!d || typeof d !== 'object' || !d.drivers || typeof d.drivers !== 'object') return out;
  for (const [name, pref] of Object.entries(d.drivers)) {
    const n = String(name).trim();
    const p = normPref(pref);
    if (n && p) out.drivers[n] = p;
  }
  return out;
}

// The prefs doc, always {v: 1, drivers: {}} shaped — missing, unreadable or corrupt reads as empty.
export async function loadDriverPrefs() {
  try {
    const { storeGet } = await import('../api.js');
    return cleanDoc(await storeGet(PREFS_KEY));
  } catch { return emptyDoc(); }
}

// Same as loadDriverPrefs, except a failed read THROWS — the weekly build uses it so it can say
// "couldn't read driver preferences" instead of quietly building without them.
export async function readDriverPrefs() {
  const { storeGet } = await import('../api.js');
  return cleanDoc(await storeGet(PREFS_KEY));
}

// Save one driver's preference (null / nothing left = remove them). Reads the doc again first so two
// dispatchers editing different drivers don't undo each other; a failed read throws instead of
// writing over everyone. Returns the new doc.
export async function saveDriverPref(name, pref) {
  const n = String(name || '').trim();
  if (!n) throw new Error('No driver name.');
  const { storeGet, storePutJSON, whoAmI } = await import('../api.js');
  const doc = cleanDoc(await storeGet(PREFS_KEY));
  for (const k of Object.keys(doc.drivers)) if (fold(k) === fold(n)) delete doc.drivers[k];
  const p = normPref(pref);
  if (p) {
    delete p.by; delete p.at;
    doc.drivers[n] = { ...p, by: whoAmI() || '', at: new Date().toISOString() };
  }
  await storePutJSON(PREFS_KEY, doc);
  return doc;
}

// first|last, letters only — how the other JAJB apps match one person across spellings
// ("Sylvia M Slate" = "Sylvia Slate"); a key two people share matches nobody.
export const personKey = (s) => {
  const t = String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  return t.length ? t[0] + '|' + t[t.length - 1] : '';
};

// Mark who is working here now (2026-10-09). `list` = the cloud's active names (activeDriversOnce).
// Each roster entry gets active: true / false; an active name nobody on the roster matches is added
// (a new hire) with active: true and isNew: true. A name on the roster keeps its spelling (the
// schedule, the prefs doc and Route Tracker already use it). Pure, for the tests.
export function markActive(roster, list) {
  const out = roster.map((r) => ({ ...r, active: false }));
  const byKey = new Map(), dup = new Set();
  for (const r of out) {
    const k = personKey(r.name);
    if (byKey.has(k)) dup.add(k); else byKey.set(k, r);
  }
  for (const raw of list || []) {
    const n = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!n) continue;
    const exact = out.find((r) => fold(r.name) === fold(n));
    const k = personKey(n);
    const hit = exact || (!dup.has(k) ? byKey.get(k) : null);
    if (hit) hit.active = true;
    else {
      const add = { name: n, tier: null, active: true, isNew: true };
      out.push(add);
      if (!byKey.has(k)) byKey.set(k, add); else dup.add(k);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Names for the Drivers page and future weeks: [{name, tier | null, tid?, active?, isNew?}] sorted
// by name (tid = Amazon Transporter ID, when the published week has it).
// Firebase: the newest published week's drivers; Netlify: this build's availability roster.
// Either way plus everyone in the prefs doc. A read that fails just leaves those names out.
// { active: true } (2026-10-09): also read the cloud's active list (dispatch/lists, the one the
// dispatch report uses) and mark everyone active / not (markActive) — new hires come in from it.
// No `active` field on any entry = the active list couldn't be read.
export async function loadDriverRoster({ active = false } = {}) {
  let activeP = Promise.resolve(null);
  if (active) {
    try { const api = await import('../api.js'); activeP = api.activeDriversOnce(); } catch { /* no list */ }
  }
  const by = new Map();
  const add = (name, tier, tid) => {
    const n = String(name || '').trim();
    if (!n) return;
    const f = fold(n);
    const cur = by.get(f);
    const t = String(tid || '').trim();
    if (!cur) by.set(f, t ? { name: n, tier: tier || null, tid: t } : { name: n, tier: tier || null });
    else {
      if (!cur.tier && tier) cur.tier = tier;
      if (!cur.tid && t) cur.tid = t;
    }
  };
  try {
    const api = await import('../api.js');
    if (api.canLive()) {
      const ws = await api.liveWeeks(3);
      for (const w of ws || []) {          // newest first; an unreadable week falls back to the one before
        try {
          const d = await api.liveWeek(w.week);
          const s = d && d.summary ? JSON.parse(d.summary) : null;
          if (s && Array.isArray(s.drivers) && s.drivers.length) {
            for (const x of s.drivers) add(x && x.name, (x && (x.cls || x.tier)) || null, x && x.tid);
            break;
          }
        } catch { /* try the week before */ }
      }
    } else {
      const { getState } = await import('../store.js');
      for (const x of getState()?.wizard?.availability?.rosterNames || []) add(typeof x === 'string' ? x : x && x.name, null);
    }
  } catch { /* names from the prefs doc only */ }
  for (const name of Object.keys((await loadDriverPrefs()).drivers)) add(name, null);
  const roster = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  let list = null;
  try { list = await activeP; } catch { list = null; }
  return list ? markActive(roster, list) : roster;
}

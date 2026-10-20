// VET / VTO offers (Driver App SPEC-v2 §6, 2026-10-12): the pure part of the Live board's
// VET / VTO strip (live/offers.js) — form state -> the fields saveScheduleOffer takes, and the
// words the card shows. No app imports, so node tests/offers_test.mjs can load it.
//
// schedule_offers/{id} as jajb.js watchScheduleOffers hands it over: {id, v, kind: vet|vto, week, date,
// day, role (vet: road|backup), wave ('10:45 AM' | '' = any), slots, status: open|filled|closed, taken,
// audience: {tiers, maxWeekHours}, mode: fcfs|window, windowHours, decideAt (ms), priority, note, by,
// at (ms), closedBy?, closedAt?, editedBy?, editedAt? (ms)}. status closed = cancelled ("Cancel offer",
// Jose 2026-10-20). takes/{tid}: {tid, name, at (ms), role, counter, status: approved|waiting|pending|applied|
// refused|declined|removed, why?, decidedBy?, reason? (removed: deleted|moved|back)}.

// the driver tiers as the Driver App names them (SPEC-v2 §9)
export const TIERS = ['Top performer', 'Solid', 'Fair', 'Underperforming', 'Termination review'];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parse = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d); };
const isoOf = (t) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;

// The form as it opens.
export function defaultForm() {
  return {
    kind: 'vet', date: '', role: 'road', wave: '', slots: '1',
    sendTo: 'all', tiers: [], under: false, underHours: '40',
    mode: 'fcfs', windowHours: '24', prTiers: ['Top performer'], prHours: '40',
    note: '',
  };
}

// "Sat Oct 17"
export function dayLabel(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return String(iso || '');
  const t = parse(iso);
  return `${DOW[t.getDay()]} ${MON[t.getMonth()]} ${t.getDate()}`;
}

// "Tue 6 PM" / "Mon 2:14 PM" (this computer's clock); '' for none.
export function timeLabel(ms) {
  if (!ms) return '';
  const t = new Date(ms);
  const h = t.getHours(), m = t.getMinutes();
  return `${DOW[t.getDay()]} ${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 ? 'PM' : 'AM'}`;
}

// The shown week's days an offer can be posted for: open days from today on.
// days = the board's view.days [{day, date, open, waves}] -> [{day, date, label}]
export function offerDays(days, today) {
  return (days || []).filter((x) => x && x.date >= today && x.open !== false)
    .map((x) => ({ day: x.day, date: x.date, label: dayLabel(x.date) }));
}

// "10:05 AM" < "10:25 AM" < "1:05 PM"
const waveMins = (w) => { const m = String(w).match(/(\d{1,2}):(\d{2}) ([AP]M)/); if (!m) return 9999;
  return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2]; };
// A day's wave times as the board knows them (its route counts), earliest first.
export function offerWaves(info) {
  return Object.entries((info && info.waves) || {}).filter(([, n]) => Number(n) > 0).map(([w]) => w)
    .sort((a, b) => waveMins(a) - waveMins(b));
}

const whole = (v, lo, hi) => { const s = String(v ?? '').trim(); if (!/^\d+$/.test(s)) return null;
  const n = Number(s); return n >= lo && n <= hi ? n : null; };
const tiersIn = (list) => TIERS.filter((t) => (list || []).includes(t));

// The form -> {fields} for saveScheduleOffer (week, day, decideAt, by, at are the hub's), or {error}.
export function buildOfferFields(f) {
  if (f.kind !== 'vet' && f.kind !== 'vto') return { error: 'Pick VET or VTO.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.date || ''))) return { error: 'Pick a day.' };
  const slots = whole(f.slots, 1, 50);
  if (slots == null) return { error: 'Spots must be a whole number from 1 to 50.' };
  const fields = { kind: f.kind, date: f.date, wave: f.kind === 'vet' ? String(f.wave || '') : '', slots };
  if (f.kind === 'vet') fields.role = f.role === 'backup' ? 'backup' : 'road';
  if (f.sendTo === 'groups') {
    const tiers = tiersIn(f.tiers);
    let max = null;
    if (f.under) {
      max = whole(f.underHours, 1, 168);
      if (max == null) return { error: 'Hours this week must be a whole number from 1 to 168.' };
    }
    if (!tiers.length && max == null) return { error: 'Pick at least one group, or send to everyone.' };
    fields.audience = { tiers, maxWeekHours: max };
  } else {
    fields.audience = { tiers: [], maxWeekHours: null };
  }
  if (f.mode === 'window') {
    const wh = whole(f.windowHours, 1, 168);
    if (wh == null) return { error: 'The wait must be a whole number of hours from 1 to 168.' };
    const ph = whole(f.prHours, 1, 168);
    if (ph == null) return { error: 'Approve-right-away hours must be a whole number from 1 to 168.' };
    fields.mode = 'window';
    fields.windowHours = wh;
    fields.priority = { tiers: tiersIn(f.prTiers), maxWeekHours: ph };
  } else {
    fields.mode = 'fcfs';
  }
  const note = String(f.note || '').trim();
  if (note) fields.note = note.slice(0, 300);
  return { fields };
}

// What the offer is: "10:45 AM route", "backup, any wave", "day off".
export function offerWhat(o) {
  if (o.kind !== 'vet') return 'day off';
  const role = o.role === 'backup' ? 'backup' : 'route';
  return o.wave ? `${o.wave} ${role}` : `${role}, any wave`;
}

// The Cancel / Delete confirmations' words: "VET · Sat Oct 17 · 10:45 AM route · 1 of 3 taken"
export function offerLabel(o) {
  return `${o.kind === 'vto' ? 'VTO' : 'VET'} · ${dayLabel(o.date)} · ${offerWhat(o)} · ${Number(o.taken) || 0} of ${Number(o.slots) || 0} taken`;
}

// the engine's / server's refusal codes in plain words; anything else is shown as it came
const WHY = {
  blocked: 'a rule blocks it', limits: 'over the hour limits', unavail: 'asked for that day off',
  not_on_schedule: 'not on the schedule', no_shift: 'no shift that day', changed: 'the schedule changed',
};
export const whyText = (why) => (why ? (WHY[why] || String(why)) : '');

const REMOVED = { deleted: 'Removed (shift deleted)', moved: 'Removed (moved)', back: 'Removed (back on schedule)' };

// The role a VET counter asks for: the take's own role when it differs, else the other one.
const counterRole = (t, o) => (t.role && t.role !== o.role ? t.role : (o.role === 'backup' ? 'road' : 'backup'));

// A take's status in words, and whether a manager has to answer it (Yes / No).
// -> {text, ask}
export function takeStatus(t, o) {
  const as = t.counter ? (counterRole(t, o) === 'backup' ? ' — as a backup' : ' — as a route') : '';
  switch (t.status) {
    case 'approved': return { text: 'Approved' + as, ask: false };
    case 'applied': return { text: 'On the board' + as, ask: false };
    case 'waiting': return { text: o.decideAt ? `Waiting until ${timeLabel(o.decideAt)}` : 'Waiting', ask: false };
    case 'refused': { const w = whyText(t.why); return { text: w ? `Couldn't add — ${w}` : "Couldn't add", ask: false }; }
    case 'declined': return { text: 'Declined', ask: false };
    // a manager took the shift off the Live board again: the Driver App undid the take (2026-10-20)
    case 'removed': return { text: REMOVED[t.reason] || 'Removed', ask: false };
    case 'pending':
      if (t.counter) return { text: counterRole(t, o) === 'backup' ? 'Asked for backup instead' : 'Asked for a route instead', ask: true };
      return { text: 'Pending', ask: false };
    default: return { text: String(t.status || ''), ask: false };
  }
}

// --- The day strip (Jose 2026-10-13): one picked day's offers at the top of the Live board.

// That day's offers, VET before VTO, then by wave (any wave last), then oldest first.
export function dayOffers(rows, date) {
  return (rows || []).filter((o) => o && o.date === date).slice().sort((a, b) =>
    (a.kind === 'vto') - (b.kind === 'vto') || (a.wave ? waveMins(a.wave) : 9998) - (b.wave ? waveMins(b.wave) : 9998)
    || (Number(a.at) || 0) - (Number(b.at) || 0));
}

// Every offer from today on (only those dates when dates is a list), by day, earliest first:
// [{date, label: 'Tue Oct 13', offers (as dayOffers sorts them)}]. Cancelled offers are left out unless
// withCancelled (Jose 2026-10-20: no clutter — "Show cancelled (N)" brings them back).
export function upcomingGroups(rows, today, dates, withCancelled = false) {
  const pick = Array.isArray(dates) && dates.length ? new Set(dates) : null;
  const keep = (rows || []).filter((o) => o && String(o.date || '') >= today && (!pick || pick.has(o.date))
    && (withCancelled || !isCancelled(o)));
  const ds = [...new Set(keep.map((o) => o.date))].sort();
  return ds.map((date) => ({ date, label: dayLabel(date), offers: dayOffers(keep, date) }));
}

// --- Cancel / edit / delete (Jose 2026-10-20: run offers from the Requests tab too)

// status closed = cancelled
export const isCancelled = (o) => !!o && o.status === 'closed';
// offers -> {live (not cancelled), cancelled}, order kept
export function splitCancelled(offers) {
  const live = [], cancelled = [];
  for (const o of offers || []) if (o) (isCancelled(o) ? cancelled : live).push(o);
  return { live, cancelled };
}
// "Show cancelled (2)" / "Hide cancelled (2)"
export const cancelledToggle = (n, shown) => `${shown ? 'Hide' : 'Show'} cancelled (${n})`;

// takes still alive on an offer: approved / on the board / waiting / a counter to answer
const LIVE_TAKES = new Set(['approved', 'applied', 'waiting', 'pending']);
// Delete is offered on a cancelled offer nobody took: taken 0 (what the rules check) and no take approved / on
// the board / waiting / pending (a manager-approved counter uses no slot, so only the takes show it).
// takes undefined (not read yet) / null (refused): not yet.
export function canDelete(o, takes) {
  return isCancelled(o) && (Number(o.taken) || 0) === 0 && Array.isArray(takes) && !takes.some((t) => t && LIVE_TAKES.has(t.status));
}
// Why a cancelled offer can't be deleted ('' when it can, or while its takes aren't read yet)
export function deleteBlocked(o, takes) {
  if (!isCancelled(o) || canDelete(o, takes)) return '';
  if (!Array.isArray(takes) && !(Number(o.taken) > 0)) return '';
  return 'Kept: a driver took this shift — it stays as the record.';
}

// "Cancel this offer (VET · …)? Drivers won't be able to take it any more." + when takes are on the board:
// "N driver(s) already have this shift on the schedule. Cancelling doesn't take it off; remove it on the Live board."
export function cancelConfirm(o, takes) {
  const n = Array.isArray(takes) ? takes.filter((t) => t && (t.status === 'approved' || t.status === 'applied')).length
    : Number(o.taken) || 0;
  const base = `Cancel this offer (${offerLabel(o)})? Drivers won't be able to take it any more.`;
  return n ? `${base}\n\n${n} driver${n === 1 ? '' : 's'} already ${n === 1 ? 'has' : 'have'} this shift on the schedule. `
    + "Cancelling doesn't take it off; remove it on the Live board." : base;
}
export const deleteConfirm = (o) => `Delete this cancelled offer (${offerLabel(o)})? It's gone for good.`;

// "Posted by Ann · Tue 6 PM · edited by Bo · Wed 9 AM" (+ " · cancelled by Cy · Wed 10 AM")
export function postedLine(o) {
  const who = (by, at) => `${by || '—'}${at ? ' · ' + timeLabel(at) : ''}`;
  let s = `Posted by ${who(o.by, o.at)}`;
  if (o.editedBy || o.editedAt) s += ` · edited by ${who(o.editedBy, o.editedAt)}`;
  if (isCancelled(o) && (o.closedBy || o.closedAt)) s += ` · cancelled by ${who(o.closedBy, o.closedAt)}`;
  return s;
}

const hrs = (h, d) => (h == null || h === '' ? d : String(h));
// An offer -> the form, for Edit (the locked fields come along so the form shows them and the preview counts them)
export function editForm(o) {
  const a = (o && o.audience) || {};
  const tiers = TIERS.filter((t) => (a.tiers || []).includes(t));
  const under = a.maxWeekHours != null && a.maxWeekHours !== '';
  const p = (o && o.priority) || {};
  return {
    kind: o.kind === 'vto' ? 'vto' : 'vet', date: String(o.date || ''), role: o.role === 'backup' ? 'backup' : 'road',
    wave: String(o.wave || ''), slots: String(Number(o.slots) || 1),
    sendTo: tiers.length || under ? 'groups' : 'all', tiers, under, underHours: hrs(a.maxWeekHours, '40'),
    mode: o.mode === 'window' ? 'window' : 'fcfs', windowHours: hrs(o.windowHours, '24'),
    prTiers: o.priority ? TIERS.filter((t) => (p.tiers || []).includes(t)) : defaultForm().prTiers, prHours: hrs(p.maxWeekHours, '40'),
    note: String(o.note || ''),
  };
}
// The edit form -> {fields: {slots, audience, note}} for editScheduleOffer, or {error}. Spots never below
// what's taken (the offer's own count).
export function buildEditFields(f, o) {
  const r = buildOfferFields(f);
  if (r.error) return r;
  const taken = Number(o && o.taken) || 0;
  if (r.fields.slots < taken) return { error: `Spots can't be below the ${taken} already taken.` };
  return { fields: { slots: r.fields.slots, audience: r.fields.audience, note: r.fields.note || '' } };
}
// What the recipient preview sends: the form's offer as posted, spots and note left out (they change nobody's
// card) -> fields, or null when the form can't be counted yet.
export function previewFields(f) {
  const r = buildOfferFields({ ...f, slots: '1', note: '' });
  return r.error ? null : r.fields;
}
// The preview line (drv_offer_preview {eligible, withApp, withPush}): "22 drivers can see this · 4 use the app ·
// 1 gets a phone alert"; "—" for each number while loading; "Couldn't count" on an error.
// st = {state: 'loading' | 'err' | 'ok', res}
export function previewLabel(st) {
  if (st && st.state === 'err') return "Couldn't count";
  const r = st && st.state === 'ok' && st.res ? st.res : null;
  const n = (k) => (r && Number.isFinite(Number(r[k])) ? Number(r[k]) : null);
  const e = n('eligible'), a = n('withApp'), p = n('withPush');
  const num = (x) => (x == null ? '—' : String(x));
  return `${num(e)} driver${e === 1 ? '' : 's'} can see this · ${num(a)} ${a === 1 ? 'uses' : 'use'} the app · `
    + `${num(p)} ${p === 1 ? 'gets' : 'get'} a phone alert`;
}

// "VET · 10:45 AM route" / "VET · backup, any wave" / "VTO · day off"
export const stripHead = (o) => `${o.kind === 'vto' ? 'VTO' : 'VET'} · ${offerWhat(o)}`;

// takes -> {offered, taken, waiting}: taken = approved / on the board, waiting = waiting + counters to answer.
// takes undefined/null (not read yet): taken falls back to the offer's own count.
export function offerCounts(o, takes) {
  const offered = Number(o && o.slots) || 0;
  if (!Array.isArray(takes)) return { offered, taken: Number(o && o.taken) || 0, waiting: 0 };
  let taken = 0, waiting = 0;
  for (const t of takes) {
    if (!t) continue;
    if (t.status === 'approved' || t.status === 'applied') taken++;
    else if (t.status === 'waiting' || (t.status === 'pending' && t.counter)) waiting++;
  }
  return { offered, taken, waiting };
}

// "3 offered · 1 approved · 1 waiting" ("· 0 waiting" left out); same word as the day headers
export const countsLabel = (c) => `${c.offered} offered · ${c.taken} approved${c.waiting ? ` · ${c.waiting} waiting` : ''}`;

// The strip's chip: {word, chip}: cancelled (grey), full (grey: filled, or every spot taken), else open (green).
export function stripStatus(o, c) {
  if (o.status === 'closed') return { word: 'cancelled', chip: 'gray' };
  if (o.status === 'filled' || (c && c.offered > 0 && c.taken >= c.offered)) return { word: 'full', chip: 'gray' };
  return { word: 'open', chip: 'green' };
}

// --- Day headers (Jose 2026-10-13): plain-word counts and the day's VET / VTO line.

// A day's counts button: {drivers: '31/32 drivers', backups: '6/8 backups'} (d = a view.days entry)
export function headCounts(d) {
  return { drivers: `${d.routes_filled}/${d.routes} drivers`, backups: `${d.backup_filled}/${d.backup} backups` };
}

// A date's offers that aren't closed, per kind (VET first, kinds with none left out):
// [{kind: 'vet'|'vto', offered (slots summed), approved, waiting}] — the counts as offerCounts makes them.
// takesById = {offerId: takes[] | undefined}
export function daySummary(rows, date, takesById) {
  const by = {};
  for (const o of rows || []) {
    if (!o || o.date !== date || o.status === 'closed') continue;
    const kind = o.kind === 'vto' ? 'vto' : 'vet';
    const c = offerCounts(o, (takesById || {})[o.id]);
    const s = by[kind] || (by[kind] = { kind, offered: 0, approved: 0, waiting: 0 });
    s.offered += c.offered; s.approved += c.taken; s.waiting += c.waiting;
  }
  return ['vet', 'vto'].filter((k) => by[k]).map((k) => by[k]);
}

// "VET 3 · 1 approved" / "VTO 2 · 2 approved · 1 waiting"
export const daySummaryLabel = (s) => `${s.kind === 'vto' ? 'VTO' : 'VET'} ${s.offered} · ${s.approved} approved${s.waiting ? ` · ${s.waiting} waiting` : ''}`;

// The phone's day pills: a dot when that date has an open offer.
export const hasOpenOffer = (rows, date) => (rows || []).some((o) => o && o.date === date && o.status === 'open');

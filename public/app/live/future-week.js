// A week not built yet on the Live board (2026-10-09): just the drivers and the days they can't
// work — requested days off (entered here, live for everyone) and their standing preferences.
// When the week is built, the builder turns these days into Unavailable. Nothing of the published
// board (engine, summary, change log, autosave) runs for it.
import { html } from '../preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { setState, toast } from '../store.js';
import { Spinner } from '../ui.js';
import { canTimeoff, watchTimeoff, saveTimeoff, clearTimeoff, canEditLocks, watchLocks, saveLock, clearLock,
  canReviews, watchReviews, storeGet } from '../api.js';
import { loadDriverPrefs, loadDriverRoster, saveDriverPref, weekUnavailable, WHY_LABEL, prefSummary, prefHasLimit } from '../lib/driver-prefs.js';
import { lockOf, lockConflicts, conflictLine, conflictQuestion, lockShift, lockShort, lockLine } from '../lib/locks.js';
import { LockMark } from './lock-mark.js';
import { DAYS } from '../lib/waves.js';
import { parseISODate, toISODate, addDays } from '../lib/weeks.js';
import { SHIFT_COLORS, todayISO } from './live-model.js';

// search ignores case and accents, as on the board ("jose" finds "José")
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// name matching as driver-prefs.js does it
const nkey = (s) => String(s || '').trim().toLowerCase();
const shortDate = (iso) => { const d = parseISODate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US',
  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'just now');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SAVE_ERR = "Couldn't save — check your connection and try again.";
const FULL_DAY = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
const openDriver = (name) => setState({ route: 'drivers', driversOpen: name });

// The roster read goes through the newest published week and the cloud's active list (2026-10-09:
// new hires show, people who left don't): kept for a few minutes, so moving between future weeks
// doesn't read it again each time.
let rosterCache = null;
function rosterOnce() {
  if (!rosterCache || Date.now() - rosterCache.at > 5 * 60e3) rosterCache = { at: Date.now(), p: loadDriverRoster({ active: true }) };
  return rosterCache.p;
}

// What a lock on (name, date) clashes with — the driver's own time off, and a picked trainer's — as warning lines.
function clashes(name, date, trainer, src) {
  const own = lockConflicts(name, date, src);
  const tr = trainer ? lockConflicts(trainer, date, src).map((c) => ({ ...c, who: `Trainer ${trainer}` })) : [];
  return [...own, ...tr];
}

// <input type="time"> "13:05" <-> the schedule's "1:05 PM"
const to12 = (v) => { const m = String(v || '').match(/^(\d{1,2}):(\d{2})/); if (!m) return '';
  const h = Number(m[1]); return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`; };
const SHIFTS = [['route', 'Route'], ['meeting', 'Meeting'], ['dispatch', 'Dispatch']];

// "Lock: working this day" (2026-11-20, lib/locks.js): what they come in for (2026-11-24: a route — any
// time or a set time —, a meeting at a time, or dispatch), the note, the optional training day and its
// trainer; a clash with time off asks first and keeps the time-off record as it is.
function LockForm({ week, name, date, dayTxt, trainers, src, onDone, onCancel }) {
  const first = name.split(/\s+/)[0];
  const [shift, setShift] = useState('route');
  const [time, setTime] = useState('');            // "HH:MM" from the time box, '' = any time
  const [label, setLabel] = useState('');          // the meeting's name
  const [note, setNote] = useState('');
  const [training, setTraining] = useState(false);
  const [trainer, setTrainer] = useState('');
  const [ask, setAsk] = useState('');               // the time-off question, '' = not asking
  const [saving, setSaving] = useState(false);
  const pick = (trainers || []).filter((t) => nkey(t) !== nkey(name));
  const save = async (sure) => {
    if (saving) return;
    if (shift === 'meeting' && !time) { toast('Pick the meeting time.', 'err'); return; }
    const isTrain = shift === 'route' && training;
    const q = conflictQuestion(clashes(name, date, isTrain ? trainer : '', src), date);
    if (q && !sure) { setAsk(q); return; }
    setSaving(true);
    try {
      const lk = { driverKey: name, date, note: note.trim().slice(0, 300), training: isTrain, trainer: isTrain ? trainer : '',
        shift, time: shift === 'dispatch' ? '' : to12(time), label: shift === 'meeting' ? label.trim().slice(0, 60) : '' };
      await saveLock(week, lk);
      toast(`🔒 ${first} locked in on ${dayTxt}: ${lockShort(lk)}`);
      onDone();
    } catch { toast(SAVE_ERR, 'err'); setSaving(false); }
  };
  if (ask) {
    return html`<div class="fw-menu-form">
      <p class="lk-ask" role="alert">⚠ ${ask}</p>
      <p class="muted" style="margin:0 0 8px">The time off stays on file as it is.</p>
      <div class="row">
        <button class="small primary" disabled=${saving} onClick=${() => save(true)}>${saving ? 'Saving…' : 'Lock anyway'}</button>
        <button class="small ghost" disabled=${saving} onClick=${onCancel}>Cancel</button>
      </div></div>`;
  }
  return html`<div class="fw-menu-form">
    <div class="fw-menu-title">🔒 Lock ${first} working ${dayTxt}</div>
    <div class="seg lk-shift" role="group" aria-label="Coming in for">
      ${SHIFTS.map(([k, t]) => html`<button type="button" class=${shift === k ? 'on' : ''} aria-pressed=${shift === k}
        disabled=${saving} onClick=${() => setShift(k)}>${t}</button>`)}
    </div>
    ${shift === 'meeting' ? html`<input type="text" maxlength="60" placeholder="Meeting name (optional, e.g. Safety)" value=${label}
      disabled=${saving} aria-label="Meeting name" onInput=${(e) => setLabel(e.target.value)} />` : ''}
    ${shift !== 'dispatch' ? html`<label class="lk-time">${shift === 'meeting' ? 'Time' : 'Time (optional)'}
      <input type="time" value=${time} disabled=${saving} aria-label=${shift === 'meeting' ? 'Meeting time' : 'Route time (optional)'}
        onInput=${(e) => setTime(e.target.value)} />
      ${shift === 'route' ? html`<span class="muted">${time ? 'gets this wave if it has room' : 'blank = any wave'}</span>` : ''}</label>` : ''}
    <input type="text" maxlength="300" placeholder="Note (optional)" value=${note} disabled=${saving}
      aria-label="Note (optional)" onInput=${(e) => setNote(e.target.value)} />
    ${shift === 'route' ? html`<label class="lk-check"><input type="checkbox" checked=${training} disabled=${saving}
      onChange=${(e) => setTraining(e.target.checked)} /> Training day</label>` : ''}
    ${shift === 'route' && training ? html`<select class="lk-trainer" value=${trainer} disabled=${saving} aria-label="Trainer"
        onChange=${(e) => setTrainer(e.target.value)}>
        <option value="">Trainer: the builder picks</option>
        ${pick.map((t) => html`<option value=${t}>${t}</option>`)}
      </select>` : ''}
    <div class="row">
      <button class="small primary" disabled=${saving} onClick=${() => save(false)}>${saving ? 'Saving…' : 'Lock'}</button>
      <button class="link" disabled=${saving} onClick=${onCancel}>Cancel</button>
    </div></div>`;
}

// The card anchored under a clicked day.
function DayMenu({ week, m, canEdit, prefs, onPrefs, onClose, lock, canLock, trainers, src }) {
  const { name, day, date, rec, why } = m;
  const first = name.split(/\s+/)[0];
  const dayTxt = `${day} ${shortDate(date)}`;
  const [form, setForm] = useState(!why && !lock);  // the note box + save button
  const [note, setNote] = useState(rec && rec.note ? rec.note : '');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);  // "won't be scheduled on any Wednesday" check
  const [locking, setLocking] = useState(false);  // the lock form
  const alive = useRef(true);
  const inp = useRef(null);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { if (form && inp.current) inp.current.focus(); }, [form]);

  // the live watch shows the result: nothing here sticks if the write fails
  const go = async (fn, ok) => {
    if (saving) return;
    setSaving(true);
    try { await fn(); toast(ok); onClose(); }
    catch { toast(SAVE_ERR, 'err'); }
    finally { if (alive.current) setSaving(false); }
  };
  const save = () => go(() => saveTimeoff(week, rec ? rec.name : name, date, note.trim().slice(0, 300)),
    rec ? 'Note saved' : `${first} marked off ${dayTxt}`);
  const remove = () => go(() => clearTimeoff(week, rec.name, date), `${first}'s day off on ${dayTxt} removed`);

  // Standing "can't work this weekday" — the same as unticking the day on Driver preferences.
  // Saved under the spelling the prefs doc already has, so no duplicate entry.
  const prefKey = Object.keys((prefs && prefs.drivers) || {}).find((k) => nkey(k) === nkey(name)) || null;
  const cur = prefKey ? prefs.drivers[prefKey] : null;
  const prefName = prefKey || (rec ? rec.name : name);
  const full = FULL_DAY[day] || day;
  const setDays = async (days, ok, after) => {
    if (saving) return;
    setSaving(true);
    let doc;
    try { doc = await saveDriverPref(prefName, { ...(cur || {}), days }); }
    catch { toast(SAVE_ERR, 'err'); if (alive.current) setSaving(false); return; }
    onPrefs(doc);
    if (after) { try { await after(); } catch { /* harmless: the preference covers it */ } }
    toast(ok);
    onClose();
  };
  const repeat = () => {
    const days = (cur && cur.days && cur.days.length ? cur.days : DAYS).filter((d) => d !== day);
    if (!days.length) { toast('That would leave no days they can work.', 'err'); return; }
    setDays(days, `${first} can't work ${full}s from now on`,
      why === 'timeoff' && rec ? () => clearTimeoff(week, rec.name, date) : null);
  };
  const canAgain = () => {
    const base = cur && cur.days && cur.days.length ? cur.days : DAYS;
    setDays(DAYS.filter((d) => d === day || base.includes(d)), `${first} can work ${full}s again`, null);
  };
  const repeatBtn = html`<button class="small" disabled=${saving} onClick=${() => setConfirm(true)}>Repeat every ${day}</button>`;
  const head = html`<div class="fw-menu-head"><b>${name}</b> <span class="muted">${dayTxt}</span>
    <button class="dm-x fw-x" aria-label="Close" onClick=${onClose}>×</button></div>`;
  if (locking) {
    return html`<div class="fw-menu" role="dialog" aria-label=${`${name}, ${dayTxt}`} style=${m.style}>${head}
      <${LockForm} week=${week} name=${name} date=${date} dayTxt=${dayTxt} trainers=${trainers} src=${src}
        onDone=${onClose} onCancel=${() => setLocking(false)} /></div>`;
  }
  // a locked day (2026-11-20): who, when, the training, a clash with time off; Unlock for a manager
  const unlock = () => go(() => clearLock(week, lock.driverKey, date), `${first} unlocked on ${dayTxt}`);
  const lockClash = lock ? clashes(name, date, lock.training ? lock.trainer : '', src) : [];

  return html`<div class="fw-menu" role="dialog" aria-label=${`${name}, ${dayTxt}`} style=${m.style}>
    ${head}
    ${lock ? html`<div class="fw-menu-info lk-info">
      <div><b>🔒 ${lockLine(lock)}</b>
        <span class="muted"> · by ${lock.by || '—'}, ${when(lock.at)}</span></div>
      ${lock.training ? html`<div>Trainer: ${lock.trainer || 'the builder picks'}</div>` : ''}
      ${lock.note ? html`<div class="fw-menu-note">“${lock.note}”</div>` : ''}
      ${lockClash.map((c) => html`<div class="lk-ask">⚠ ${conflictLine(c, date, c.who)} — still on file</div>`)}
      ${canLock ? html`<div class="row fw-menu-acts"><button class="small" disabled=${saving} onClick=${unlock}>${saving ? 'Saving…' : 'Unlock'}</button></div>`
        : html`<p class="muted" style="margin:4px 0 0">Only a manager can change a lock.</p>`}
    </div>` : ''}
    ${why === 'timeoff' ? html`<div class="fw-menu-info">
      <div><b>${WHY_LABEL.timeoff}</b> <span class="muted">· by ${(rec && rec.by) || '—'}, ${when(rec && rec.at)}</span></div>
      ${rec && rec.note ? html`<div class="fw-menu-note">“${rec.note}”</div>` : ''}</div>` : ''}
    ${why === 'days' || why === 'weekend' || why === 'altday' ? html`<div class="fw-menu-info">
      <b>${WHY_LABEL[why]}</b> — from their preferences</div>` : ''}
    ${lock && !why ? ''
      : !canEdit ? html`<p class="muted" style="margin:6px 0 0">Days off are entered on the JAJB site.</p>`
      : confirm ? html`<div class="fw-menu-form">
        <p style="margin:6px 0 8px">${first} won't be scheduled on any ${full} from now on — same as unticking ${day} on Driver preferences.</p>
        <div class="row">
          <button class="small primary" disabled=${saving} onClick=${repeat}>${saving ? 'Saving…' : `Yes, every ${full}`}</button>
          <button class="small ghost" disabled=${saving} onClick=${() => setConfirm(false)}>Cancel</button>
        </div></div>`
      : form ? html`<div class="fw-menu-form">
        ${!rec ? html`<div class="fw-menu-title">Mark ${first} off ${dayTxt}</div>` : ''}
        <input ref=${inp} type="text" maxlength="300" placeholder="Note (optional)" value=${note} disabled=${saving}
          aria-label="Note (optional)" onInput=${(e) => setNote(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') onClose(); }} />
        <div class="row">
          <button class="small primary" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : rec ? 'Save note' : 'Mark day off'}</button>
          ${!why ? repeatBtn : ''}
          ${why ? html`<button class="link" disabled=${saving} onClick=${() => setForm(false)}>Cancel</button>` : ''}
        </div></div>`
      : why === 'timeoff' ? html`<div class="row fw-menu-acts">
        <button class="small" disabled=${saving} onClick=${remove}>${saving ? 'Saving…' : 'Remove'}</button>
        <button class="small" disabled=${saving} onClick=${() => setForm(true)}>Edit note</button>
        ${repeatBtn}</div>`
      : html`<div class="row fw-menu-acts">
        ${why === 'days' ? html`<button class="small" disabled=${saving} onClick=${canAgain}>${saving ? 'Saving…' : `Can work ${full}s again`}</button>` : ''}
        <button class="small" disabled=${saving} onClick=${() => openDriver(name)}>Edit preferences</button>
        <button class="small" disabled=${saving} onClick=${() => setForm(true)}>Mark day off anyway</button></div>`}
    ${!lock && canLock && !confirm ? html`<div class="row fw-menu-acts lk-acts">
      <button class="small" disabled=${saving} onClick=${() => setLocking(true)}>🔒 Lock: working this day</button></div>` : ''}
  </div>`;
}

export function FutureWeek({ week, label }) {
  const [roster, setRoster] = useState(null);   // [{name, tier}]
  const [prefs, setPrefs] = useState(null);     // {v, drivers}
  const [timeoff, setTimeoff] = useState(null); // {"<ISO>|<name>": {name, day, note, by, at}} | null = loading
  const [q, setQ] = useState('');
  const [only, setOnly] = useState(false);       // only drivers with a day off this week
  const [menu, setMenu] = useState(null);        // {name, day, date, top, left}
  const [locks, setLocks] = useState(null);      // locked days (2026-11-20): {"<ISO>|<name>": lock} | null = loading
  const [lockErr, setLockErr] = useState(false); // the locks couldn't be read
  const [reviews, setReviews] = useState([]);    // the Driver app's day-off reviews this week (a lock's clash check)
  const [trainers, setTrainers] = useState([]);  // the marked trainers (Trainers & settings), for a training lock
  const [unlocking, setUnlocking] = useState(false);
  const wrap = useRef(null);
  const menuEl = useRef(null);

  useEffect(() => {
    let alive = true;
    rosterOnce().then((r) => { if (alive) setRoster(r || []); }, () => { if (alive) setRoster([]); });
    loadDriverPrefs().then((p) => { if (alive) setPrefs(p); }, () => { if (alive) setPrefs({ v: 1, drivers: {} }); });
    storeGet('standing/config.json').then((c) => { if (alive && c && Array.isArray(c.trainers)) setTrainers(c.trainers); }, () => {});
    return () => { alive = false; };
  }, []);

  // live: another dispatcher's day off shows up at once. A week change starts clean.
  useEffect(() => {
    let alive = true;
    setTimeoff(null); setMenu(null); setLocks(null); setLockErr(false); setReviews([]);
    const end = toISODate(addDays(parseISODate(week), 6));
    const un = watchTimeoff(week, (t) => { if (alive) setTimeoff(t || {}); });
    const unL = watchLocks(week, (l) => { if (alive) { setLocks(l || {}); setLockErr(!l); } });
    const unR = canReviews() ? watchReviews(week, end, (r) => { if (alive) setReviews(r || []); }) : null;
    return () => { alive = false; for (const f of [un, unL, unR]) if (typeof f === 'function') f(); };
  }, [week]);

  // the card closes on a click outside it, Escape, or the grid scrolling under it
  useEffect(() => {
    if (!menu) return undefined;
    const down = (e) => { if (menuEl.current && !menuEl.current.contains(e.target) && !e.target.closest('.fw-cell')) setMenu(null); };
    const key = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [!!menu]);

  if (!roster || !prefs || !timeoff || !locks) {
    return html`<div class="card"><${Spinner}/> Loading the drivers and their days off…</div>`;
  }

  const today = todayISO();
  const days = DAYS.map((day, i) => ({ day, date: toISODate(addDays(parseISODate(week), i)) }));
  const end = days[6].date;
  const weekOff = Object.values(timeoff).filter((t) => t && t.name && t.day >= week && t.day <= end);
  const unav = {};
  for (const [n, v] of Object.entries(weekUnavailable(prefs, timeoff, week))) unav[nkey(n)] = v;
  const prefOf = {};
  for (const [n, p] of Object.entries(prefs.drivers || {})) prefOf[nkey(n)] = p;
  // rows: the roster, plus anyone with a day off asked this week or a preference
  const names = new Map();
  // people who aren't active any more stay off (unless a day off was asked for them this week)
  const gone = new Set(roster.filter((r) => r.active === false).map((r) => nkey(r.name)));
  for (const r of roster) if (r.active !== false) names.set(nkey(r.name), r.name);
  for (const n of Object.keys(prefs.drivers || {})) if (!names.has(nkey(n)) && !gone.has(nkey(n))) names.set(nkey(n), n.trim());
  for (const t of weekOff) if (!names.has(nkey(t.name))) names.set(nkey(t.name), String(t.name).trim());
  const weekLocks = Object.values(locks).filter((l) => l && l.driverKey && l.date >= week && l.date <= end);
  for (const l of weekLocks) if (!names.has(nkey(l.driverKey))) names.set(nkey(l.driverKey), String(l.driverKey).trim());
  const all = [...names.values()].sort((a, b) => a.localeCompare(b));
  const rows = all.filter((n) => (!q.trim() || fold(n).includes(fold(q.trim())))
    && (!only || Object.keys(unav[nkey(n)] || {}).length));
  const asked = Object.values(unav).reduce((a, u) => a + Object.values(u).filter((x) => x.why === 'timeoff').length, 0);
  // drivers shown here (on the roster / still active) with a preference the build follows -- not a
  // note alone, not someone who left (2026-10-19)
  const limited = all.filter((n) => prefHasLimit(prefOf[nkey(n)])).length;
  const canEdit = canTimeoff();
  const canLock = canEditLocks();
  const src = { timeoff, reviews };
  const unlock = async (lk) => {
    if (unlocking) return;
    setUnlocking(true);
    try { await clearLock(week, lk.driverKey, lk.date); toast(`${String(lk.driverKey).split(/\s+/)[0]} unlocked on ${shortDate(lk.date)}`); }
    catch { toast(SAVE_ERR, 'err'); }
    finally { setUnlocking(false); }
  };

  const recOf =(name, date) => weekOff.find((t) => t.day === date && nkey(t.name) === nkey(name)) || null;
  const open = (e, name, d) => {
    const b = e.currentTarget.getBoundingClientRect();
    const box = wrap.current ? wrap.current.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth };
    const w = Math.min(320, box.width - 8);
    const left = Math.max(4, Math.min(b.left - box.left, box.width - w - 4));
    const u = (unav[nkey(name)] || {})[d.day];
    setMenu({ name, day: d.day, date: d.date, why: u ? u.why : null, rec: recOf(name, d.date),
      style: `left:${Math.round(left)}px;top:${Math.round(b.bottom - box.top + 4)}px;width:${Math.round(w)}px` });
  };
  // the open card follows what the watch says (e.g. someone else removed that day off)
  const live = menu ? (() => {
    const u = (unav[nkey(menu.name)] || {})[menu.day];
    return { ...menu, why: u ? u.why : null, rec: recOf(menu.name, menu.date) };
  })() : null;

  return html`<div class="card">
    <h2 style="margin-bottom:4px">${label} <span class="chip blue fw-badge">Not built yet</span></h2>
    <p class="hint" style="margin:0">Click a day to mark it off${canLock ? ' or lock the driver in to work it' : ''}. When you build this week,
      days off go in as Unavailable${weekLocks.length || canLock ? ' and 🔒 locked days are placed first and kept' : ''}.</p>
    <p class="muted" style="margin:4px 0 0">${plural(asked, 'day off asked', 'days off asked')} · ${plural(limited, 'driver with limits', 'drivers with limits')}${
      weekLocks.length ? ` · ${plural(weekLocks.length, 'locked day', 'locked days')}` : ''}</p>
    ${lockErr ? html`<p class="muted lk-ask" style="margin:4px 0 0">Couldn't read the locked days — check the connection.</p>` : ''}

    <div class="row lv-tools">
      <input type="search" placeholder="Search a driver…" value=${q} onInput=${(e) => setQ(e.target.value)}
        aria-label="Search a driver by name" />
      <div class="seg" role="group" aria-label="Show only drivers with days off">
        <button class=${only ? 'on' : ''} aria-pressed=${only} onClick=${() => setOnly((o) => !o)}>Only drivers with days off</button>
      </div>
      ${q.trim() || only ? html`<span class="muted">${rows.length} of ${all.length} drivers</span>` : ''}
    </div>

    <div class="fw-wrap" ref=${wrap}>
      <div class="scroll-x lv-wrap" onScroll=${() => menu && setMenu(null)}><table class="lv-grid fw-grid">
        <thead><tr>
          <th class="lv-namecol">Driver</th>
          ${days.map((x) => html`<th class=${x.date === today ? 'today' : x.date < today ? 'past' : ''}>
            ${x.day} <span class="lv-date">${shortDate(x.date)}</span></th>`)}
        </tr></thead>
        <tbody>
          ${!rows.length ? html`<tr><td colspan="8" class="muted" style="text-align:left">${!all.length
            ? 'No drivers yet — names come from the newest published week and the Drivers page.'
            : q.trim() ? `No driver matches “${q}”${only ? ' with a day off' : ''}.` : 'Nobody has a day off this week.'}</td></tr>` : ''}
          ${rows.map((name) => {
            const u = unav[nkey(name)] || {};
            const chips = prefSummary(prefOf[nkey(name)]);
            return html`<tr>
              <td class="lv-namecol"><button class="link lv-name" title=${`Open ${name} on the Drivers page`}
                onClick=${() => openDriver(name)}>${name}</button>
                ${chips.length ? html`<div class="lv-sub">${chips.join(' · ')}</div>` : ''}</td>
              ${days.map((d) => {
                const x = u[d.day];
                const past = d.date < today;
                const off = x && x.why === 'timeoff';
                const lk = lockOf(weekLocks, name, d.date);
                const clash = lk ? clashes(name, d.date, lk.training ? lk.trainer : '', src) : [];
                const warn = clash.map((c) => conflictLine(c, d.date, c.who)).join('. ');
                const tip = (lk ? `🔒 ${lockLine(lk)}${lk.training && lk.trainer ? ' with ' + lk.trainer : ''}${
                  lk.note ? ' — ' + lk.note : ''}${warn ? '\n⚠ ' + warn : ''}\n` : '')
                  + (past ? 'This day is over' : off ? `${WHY_LABEL.timeoff}${x.note ? ' — ' + x.note : ''}`
                    : x ? `${WHY_LABEL[x.why]} — from their preferences` : lk ? 'Click for the lock' : 'Click to mark a day off');
                return html`<td class=${'lv-cell fw-cell k-' + (lk ? 'lock' : off ? 'off' : 'empty') + (d.date === today ? ' today' : '') + (past ? ' fw-past' : '')}
                  title=${tip} onClick=${past ? undefined : (e) => open(e, name, d)}>${lk
                    ? html`<div class=${'lv-blk b-lock' + (lockShift(lk) === 'meeting' ? ' b-lock-meet' : '')}><span>${lockShort(lk)}</span><${LockMark}
                      st=${{ kind: 'ok', text: lockLine(lk) }} warn=${warn}
                      busy=${unlocking} onUnlock=${canLock && !past ? () => unlock(lk) : undefined} /></div>`
                    : off
                    ? html`<div class="lv-blk b-off" style=${`background:${SHIFT_COLORS.off}`}><span>${WHY_LABEL.timeoff}</span></div>${
                      x.note ? html`<span class="lv-notedot" aria-label="Has a note">💬</span>` : ''}`
                    : x ? html`<span class="fw-pref">${WHY_LABEL[x.why]}</span>` : ''}</td>`;
              })}
            </tr>`;
          })}
        </tbody>
      </table></div>
      ${live ? (() => {
        const lk = lockOf(weekLocks, live.name, live.date);
        return html`<div ref=${menuEl}><${DayMenu} key=${live.name + '|' + live.date + '|' + (live.why || '') + (lk ? '|L' : '')} week=${week} m=${live}
          canEdit=${canEdit} prefs=${prefs} onPrefs=${setPrefs} onClose=${() => setMenu(null)}
          lock=${lk} canLock=${canLock} trainers=${trainers} src=${src} /></div>`;
      })() : ''}
    </div>
    <div class="lv-legend">
      <span class="lv-sw" style=${`background:${SHIFT_COLORS.off}`}>${WHY_LABEL.timeoff}</span>
      <span class="fw-pref">${WHY_LABEL.days} / ${WHY_LABEL.weekend} / ${WHY_LABEL.altday} — from their preferences</span>
      <span class="lv-sw b-lock">🔒 Locked: working</span>
      <span class="muted">⚠ = clashes with time off</span>
    </div>
  </div>`;
}

// A week not built yet on the Live board (2026-10-09): just the drivers and the days they can't
// work — requested days off (entered here, live for everyone) and their standing preferences.
// When the week is built, the builder turns these days into Unavailable. Nothing of the published
// board (engine, summary, change log, autosave) runs for it.
import { html } from '../preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { setState, toast } from '../store.js';
import { Spinner } from '../ui.js';
import { canTimeoff, watchTimeoff, saveTimeoff, clearTimeoff } from '../api.js';
import { loadDriverPrefs, loadDriverRoster, weekUnavailable, WHY_LABEL, prefSummary } from '../lib/driver-prefs.js';
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
const openDriver = (name) => setState({ route: 'drivers', driversOpen: name });

// The roster read goes through the newest published week: kept for a few minutes, so moving
// between future weeks doesn't read it again each time.
let rosterCache = null;
function rosterOnce() {
  if (!rosterCache || Date.now() - rosterCache.at > 5 * 60e3) rosterCache = { at: Date.now(), p: loadDriverRoster() };
  return rosterCache.p;
}

// The card anchored under a clicked day.
function DayMenu({ week, m, canEdit, onClose }) {
  const { name, day, date, rec, why } = m;
  const first = name.split(/\s+/)[0];
  const dayTxt = `${day} ${shortDate(date)}`;
  const [form, setForm] = useState(!why);        // the note box + save button
  const [note, setNote] = useState(rec && rec.note ? rec.note : '');
  const [saving, setSaving] = useState(false);
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

  return html`<div class="fw-menu" role="dialog" aria-label=${`${name}, ${dayTxt}`} style=${m.style}>
    <div class="fw-menu-head"><b>${name}</b> <span class="muted">${dayTxt}</span>
      <button class="dm-x fw-x" aria-label="Close" onClick=${onClose}>×</button></div>
    ${why === 'timeoff' ? html`<div class="fw-menu-info">
      <div><b>${WHY_LABEL.timeoff}</b> <span class="muted">· by ${(rec && rec.by) || '—'}, ${when(rec && rec.at)}</span></div>
      ${rec && rec.note ? html`<div class="fw-menu-note">“${rec.note}”</div>` : ''}</div>` : ''}
    ${why === 'days' || why === 'weekend' ? html`<div class="fw-menu-info">
      <b>${WHY_LABEL[why]}</b> — from their preferences</div>` : ''}
    ${!canEdit ? html`<p class="muted" style="margin:6px 0 0">Days off are entered on the JAJB site.</p>`
      : form ? html`<div class="fw-menu-form">
        ${!rec ? html`<div class="fw-menu-title">Mark ${first} off ${dayTxt}</div>` : ''}
        <input ref=${inp} type="text" maxlength="300" placeholder="Note (optional)" value=${note} disabled=${saving}
          aria-label="Note (optional)" onInput=${(e) => setNote(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') onClose(); }} />
        <div class="row">
          <button class="small primary" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : rec ? 'Save note' : 'Mark day off'}</button>
          ${why ? html`<button class="link" disabled=${saving} onClick=${() => setForm(false)}>Cancel</button>` : ''}
        </div></div>`
      : why === 'timeoff' ? html`<div class="row fw-menu-acts">
        <button class="small" disabled=${saving} onClick=${remove}>${saving ? 'Saving…' : 'Remove'}</button>
        <button class="small" disabled=${saving} onClick=${() => setForm(true)}>Edit note</button></div>`
      : html`<div class="row fw-menu-acts">
        <button class="small" onClick=${() => openDriver(name)}>Edit preferences</button>
        <button class="small" onClick=${() => setForm(true)}>Mark day off anyway</button></div>`}
  </div>`;
}

export function FutureWeek({ week, label }) {
  const [roster, setRoster] = useState(null);   // [{name, tier}]
  const [prefs, setPrefs] = useState(null);     // {v, drivers}
  const [timeoff, setTimeoff] = useState(null); // {"<ISO>|<name>": {name, day, note, by, at}} | null = loading
  const [q, setQ] = useState('');
  const [only, setOnly] = useState(false);       // only drivers with a day off this week
  const [menu, setMenu] = useState(null);        // {name, day, date, top, left}
  const wrap = useRef(null);
  const menuEl = useRef(null);

  useEffect(() => {
    let alive = true;
    rosterOnce().then((r) => { if (alive) setRoster(r || []); }, () => { if (alive) setRoster([]); });
    loadDriverPrefs().then((p) => { if (alive) setPrefs(p); }, () => { if (alive) setPrefs({ v: 1, drivers: {} }); });
    return () => { alive = false; };
  }, []);

  // live: another dispatcher's day off shows up at once. A week change starts clean.
  useEffect(() => {
    let alive = true;
    setTimeoff(null); setMenu(null);
    const un = watchTimeoff(week, (t) => { if (alive) setTimeoff(t || {}); });
    return () => { alive = false; if (typeof un === 'function') un(); };
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

  if (!roster || !prefs || !timeoff) {
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
  for (const r of roster) names.set(nkey(r.name), r.name);
  for (const n of Object.keys(prefs.drivers || {})) if (!names.has(nkey(n))) names.set(nkey(n), n.trim());
  for (const t of weekOff) if (!names.has(nkey(t.name))) names.set(nkey(t.name), String(t.name).trim());
  const all = [...names.values()].sort((a, b) => a.localeCompare(b));
  const rows = all.filter((n) => (!q.trim() || fold(n).includes(fold(q.trim())))
    && (!only || Object.keys(unav[nkey(n)] || {}).length));
  const asked = Object.values(unav).reduce((a, u) => a + Object.values(u).filter((x) => x.why === 'timeoff').length, 0);
  const limited = Object.keys(prefs.drivers || {}).length;
  const canEdit = canTimeoff();

  const recOf = (name, date) => weekOff.find((t) => t.day === date && nkey(t.name) === nkey(name)) || null;
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
    <p class="hint" style="margin:0">Click a day to mark it off. When you build this week, these days go in as Unavailable.</p>
    <p class="muted" style="margin:4px 0 0">${plural(asked, 'day off asked', 'days off asked')} · ${plural(limited, 'driver with limits', 'drivers with limits')}</p>

    <div class="row lv-tools">
      <input type="search" placeholder="Search a driver…" value=${q} onInput=${(e) => setQ(e.target.value)}
        aria-label="Search a driver by name" />
      <div class="seg" role="group" aria-label="Show only drivers with days off">
        <button class=${only ? 'on' : ''} aria-pressed=${only} onClick=${() => setOnly((o) => !o)}>Only drivers with days off</button>
      </div>
      ${q.trim() || only ? html`<span class="muted">${rows.length} of ${all.length} drivers</span>` : ''}
    </div>

    <div class="fw-wrap" ref=${wrap}>
      <div class="scroll-x lv-wrap" onScroll=${() => menu && setMenu(null)}><table class="lv-grid">
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
                const tip = past ? 'This day is over' : off ? `${WHY_LABEL.timeoff}${x.note ? ' — ' + x.note : ''}`
                  : x ? `${WHY_LABEL[x.why]} — from their preferences` : 'Click to mark a day off';
                return html`<td class=${'lv-cell fw-cell k-' + (off ? 'off' : 'empty') + (d.date === today ? ' today' : '') + (past ? ' fw-past' : '')}
                  title=${tip} onClick=${past ? undefined : (e) => open(e, name, d)}>${off
                    ? html`<div class="lv-blk b-off" style=${`background:${SHIFT_COLORS.off}`}><span>${WHY_LABEL.timeoff}</span></div>${
                      x.note ? html`<span class="lv-notedot" aria-label="Has a note">💬</span>` : ''}`
                    : x ? html`<span class="fw-pref">${WHY_LABEL[x.why]}</span>` : ''}</td>`;
              })}
            </tr>`;
          })}
        </tbody>
      </table></div>
      ${live ? html`<div ref=${menuEl}><${DayMenu} key=${live.name + '|' + live.date + '|' + (live.why || '')} week=${week} m=${live}
        canEdit=${canEdit} onClose=${() => setMenu(null)} /></div>` : ''}
    </div>
    <div class="lv-legend">
      <span class="lv-sw" style=${`background:${SHIFT_COLORS.off}`}>${WHY_LABEL.timeoff}</span>
      <span class="fw-pref">${WHY_LABEL.days} / ${WHY_LABEL.weekend} — from their preferences</span>
    </div>
  </div>`;
}

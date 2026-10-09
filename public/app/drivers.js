// Drivers page (2026-10-09): each driver's standing preferences — days they can work, most days a
// week / in a row, every other weekend, keep days together, a note. The weekly build reads these;
// the Live board deep-links here with setState({ route: 'drivers', driversOpen: '<name>' }).
import { html } from './preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { useStore, setState, toast } from './store.js';
import { Spinner } from './ui.js';
import { DAYS } from './lib/waves.js';
import { parseISODate, toISODate, addDays } from './lib/weeks.js';
import { canTimeoff, timeoffOnce, saveTimeoff, clearTimeoff, liveWeeks } from './api.js';
import { loadDriverPrefs, saveDriverPref, loadDriverRoster, normPref, prefSummary, weekendOn } from './lib/driver-prefs.js';

// case- and accent-insensitive, like the Live board's search
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const shift = (iso, n) => toISODate(addDays(parseISODate(iso), n));
const md = (iso) => parseISODate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// The next 4 weekends as their Saturday ISO; this weekend counts if today is Sat or Sun.
function nextWeekends() {
  const today = toISODate(new Date());
  const d = parseISODate(today).getDay();
  const sat = shift(today, d === 0 ? -1 : 6 - d);
  return [0, 1, 2, 3].map((i) => shift(sat, 7 * i));
}
const weekendLabel = (sat) => `Sat ${md(sat)} – Sun ${md(shift(sat, 1))}`;

const sundayOf = (iso) => shift(iso, -parseISODate(iso).getDay());
const dayLabel = (iso) => `${DAYS[parseISODate(iso).getDay()]} ${md(iso)}`;
const AHEAD = 12;   // weeks past this one, as on the Live board

// One-off days off for weeks not built yet (the Live board's future weeks show them as "Asked off").
// Saved right away, apart from the editor's Save button. Published weeks use the Live board instead.
function DaysOff({ name }) {
  const today = toISODate(new Date());
  const week0 = sundayOf(today);
  const weeks = Array.from({ length: AHEAD + 1 }, (_, i) => shift(week0, 7 * i));
  const maxDay = shift(weeks[AHEAD], 6);
  const [list, setList] = useState(null);       // [{name, day, note, week}] | null = loading
  const [warn, setWarn] = useState(false);      // some week's read failed
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const built = useRef(null);                   // Promise<Set of published week Sundays>
  useEffect(() => () => { alive.current = false; }, []);

  const load = async () => {
    const res = await Promise.all(weeks.map((w) => timeoffOnce(w).catch(() => null)));
    if (!alive.current) return;
    const out = [];
    res.forEach((r, i) => {
      for (const t of Object.values(r || {})) {
        if (t && fold(t.name) === fold(name) && t.day >= today && t.day >= weeks[i] && t.day <= shift(weeks[i], 6)) out.push({ ...t, week: weeks[i] });
      }
    });
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    setList(out);
    setWarn(res.some((r) => r === null));
  };
  useEffect(() => {
    built.current = Promise.resolve(liveWeeks(80)).then((ws) => new Set((ws || []).map((w) => w && w.week)));
    built.current.catch(() => {});
    load();
  }, []);

  const add = async () => {
    setMsg('');
    if (!date) { setMsg('Pick a date first.'); return; }
    if (date < today || date > maxDay) { setMsg(`Pick a date from ${dayLabel(today)} to ${dayLabel(maxDay)}.`); return; }
    const week = sundayOf(date);
    setBusy(true);
    try {
      let pub;
      try { pub = await built.current; }
      catch { setMsg("Couldn't check which weeks are built — check the connection."); return; }
      if (pub.has(week)) { setMsg('That week is already built — mark the day off on the Live schedule instead.'); return; }
      await saveTimeoff(week, name, date, note.trim().slice(0, 300));
      if (!alive.current) return;
      setDate(''); setNote('');
      toast('Day off added');
      await load();
    } catch {
      toast("Couldn't save — check your connection and try again.", 'err');
    } finally { if (alive.current) setBusy(false); }
  };
  const remove = async (t) => {
    setBusy(true);
    try { await clearTimeoff(t.week, t.name, t.day); await load(); }
    catch { toast("Couldn't remove it — check your connection and try again.", 'err'); }
    finally { if (alive.current) setBusy(false); }
  };

  return html`<div class="dv-dl">
    ${list === null ? html`<div class="muted small"><${Spinner}/> Loading…</div>`
      : list.length ? html`<div class="dv-dl-list">${list.map((t) => html`<div class="row dv-dl-row" key=${t.day + '|' + t.name}>
          <span class="dv-dl-day">${dayLabel(t.day)}</span>
          ${t.note ? html`<span class="muted small dv-dl-note">${t.note}</span>` : ''}
          <button class="small ghost" disabled=${busy} onClick=${() => remove(t)}>Remove</button>
        </div>`)}</div>`
      : html`<div class="muted small">None coming up.</div>`}
    ${warn ? html`<div class="muted small">Couldn't load every week's days off — check the connection.</div>` : ''}
    <div class="row dv-dl-add">
      <input type="date" min=${today} max=${maxDay} value=${date} disabled=${busy} aria-label="Date off"
        onInput=${(e) => { setDate(e.target.value); setMsg(''); }} />
      <input type="text" class="dv-dl-in" maxLength="300" placeholder="Doctor visit" value=${note} disabled=${busy}
        aria-label="Note (optional)" onInput=${(e) => setNote(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
      <button class="small" disabled=${busy} onClick=${add}>${busy ? 'Saving…' : 'Add day off'}</button>
    </div>
    ${msg ? html`<div class="small dv-dl-msg" role="alert">${msg}</div>` : ''}
    <div class="hint dv-h">Saved right away. These go in as Unavailable when that week is built.</div>
  </div>`;
}

const MAX_ROW = [['1', '1 (every other day)'], ['2', '2 (2 on, 1 off)'], ['3', '3'], ['4', '4'], ['5', '5']];

function formFrom(pref) {
  const p = normPref(pref) || {};
  const sats = nextWeekends();
  let on = sats[0];
  if (p.weekends) on = sats.find((s) => weekendOn(p, s) === true) || sats[0];
  return {
    days: p.days ? [...p.days] : [...DAYS],
    maxDays: p.maxDays ? String(p.maxDays) : '',
    maxRow: p.maxRow ? String(p.maxRow) : '',
    alternate: !!p.weekends,
    on,
    together: !!p.together,
    note: p.note || '',
  };
}

function prefFrom(f) {
  return {
    days: f.days,
    maxDays: f.maxDays ? Number(f.maxDays) : null,
    maxRow: f.maxRow ? Number(f.maxRow) : null,
    together: f.together || undefined,
    weekends: f.alternate ? { mode: 'alternate', on: f.on } : undefined,
    note: f.note,
  };
}

function Editor({ name, pref, onSaved, onClose }) {
  const [f, setF] = useState(() => formFrom(pref));
  const [busy, setBusy] = useState(false);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const toggleDay = (d) => set({ days: f.days.includes(d) ? f.days.filter((x) => x !== d) : DAYS.filter((x) => x === d || f.days.includes(x)) });
  const saved = normPref(pref);

  const write = async (p, msg) => {
    setBusy(true);
    try {
      const doc = await saveDriverPref(name, p);
      toast(msg);
      onSaved(doc);
    } catch (e) {
      toast(`Could not save ${name}'s preferences. Check the connection and try again.`, 'err');
      setBusy(false);
    }
  };
  const save = () => {
    if (!f.days.length) { toast('Pick at least one day they can work.', 'err'); return; }
    write(prefFrom(f), 'Saved');
  };
  const clear = () => {
    if (!confirm(`Clear all of ${name}'s preferences?`)) return;
    write(null, 'Cleared');
  };
  const at = saved && saved.at ? new Date(saved.at) : null;

  return html`<div class="dv-ed" onClick=${(e) => e.stopPropagation()}>
    <div class="dv-grid">
      <div class="dv-lab">Days they can work</div>
      <div>
        <div class="row dv-days">${DAYS.map((d) => {
          const on = f.days.includes(d);
          return html`<label class=${'chip ' + (on ? 'green' : 'gray dv-off')}>
            <input type="checkbox" class="dv-sr" checked=${on} onChange=${() => toggleDay(d)} />${d}</label>`;
        })}</div>
        <div class="hint dv-h">Leave all on if any day is fine.</div>
      </div>

      <label class="dv-lab" for="dv-md">Most days a week</label>
      <div><select id="dv-md" value=${f.maxDays} onChange=${(e) => set({ maxDays: e.target.value })}>
        <option value="">Any</option>
        ${[1, 2, 3, 4, 5, 6].map((n) => html`<option value=${String(n)}>${n} day${n === 1 ? '' : 's'}</option>`)}
      </select></div>

      <label class="dv-lab" for="dv-mr">Most days in a row</label>
      <div><select id="dv-mr" value=${f.maxRow} onChange=${(e) => set({ maxRow: e.target.value })}>
        <option value="">Any</option>
        ${MAX_ROW.map(([v, t]) => html`<option value=${v}>${t}</option>`)}
      </select></div>

      <label class="dv-lab" for="dv-we">Weekends</label>
      <div>
        <div class="row">
          <select id="dv-we" value=${f.alternate ? 'alt' : 'any'} onChange=${(e) => set({ alternate: e.target.value === 'alt' })}>
            <option value="any">Any weekend</option>
            <option value="alt">Every other weekend</option>
          </select>
          ${f.alternate ? html`<label class="row dv-on"><span>Their next ON weekend:</span>
            <select value=${f.on} onChange=${(e) => set({ on: e.target.value })}>
              ${nextWeekends().map((s) => html`<option value=${s}>${weekendLabel(s)}</option>`)}
            </select></label>` : ''}
        </div>
        <div class="hint dv-h">On their off weekend, Saturday and Sunday count as days off. On their on weekend, the build tries to give them both days.</div>
      </div>

      ${canTimeoff() ? html`<div class="dv-lab">Specific days off</div>
      <${DaysOff} name=${name} />` : ''}

      <div class="dv-lab">Keep days together</div>
      <div><label class="dv-check"><input type="checkbox" checked=${f.together}
        onChange=${(e) => set({ together: e.target.checked })} /> Try to put their days next to each other</label></div>

      <label class="dv-lab" for="dv-note">Note</label>
      <div><input id="dv-note" type="text" class="dv-note" maxLength="300" value=${f.note}
        placeholder="Asked on 10/9 — school on Tuesdays" onInput=${(e) => set({ note: e.target.value })} /></div>
    </div>

    <div class="row dv-btns">
      <button class="primary" disabled=${busy} onClick=${save}>${busy ? html`<${Spinner}/> Saving…` : 'Save'}</button>
      <button class="ghost" disabled=${busy} onClick=${onClose}>Cancel</button>
      ${saved ? html`<button class="ghost" disabled=${busy} onClick=${clear}>Clear all</button>` : ''}
    </div>
    ${saved && (saved.by || at) ? html`<div class="muted small dv-last">Last changed${saved.by ? ` by ${saved.by}` : ''}${at && !Number.isNaN(at.getTime())
      ? `, ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</div>` : ''}
  </div>`;
}

export function Drivers() {
  const deepLink = useStore((s) => s.driversOpen);
  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState([]);        // [{name}]
  const [prefs, setPrefs] = useState({});          // name -> Pref
  const [extra, setExtra] = useState([]);          // typed names not on the roster
  const [q, setQ] = useState('');
  const [onlyPrefs, setOnlyPrefs] = useState(false);
  const [open, setOpen] = useState(null);          // name of the driver being edited
  const [scrollTo, setScrollTo] = useState(null);
  const [addName, setAddName] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      const doc = await loadDriverPrefs();
      let names = [];
      try { names = await loadDriverRoster(); } catch { names = []; }
      if (!names.length) names = Object.keys(doc.drivers).sort((a, b) => a.localeCompare(b)).map((name) => ({ name }));
      if (!live) return;
      setPrefs(doc.drivers);
      setRoster(names);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  const prefOf = (name) => {
    const k = Object.keys(prefs).find((x) => fold(x) === fold(name));
    return k ? prefs[k] : null;
  };
  const allNames = () => [...roster.map((r) => r.name), ...extra];
  const findName = (typed) => allNames().find((n) => fold(n) === fold(typed));

  // Open a driver's editor, adding them to the list if they aren't on it.
  const openFor = (typed, scroll) => {
    const t = String(typed || '').trim();
    if (!t) return;
    const hit = findName(t);
    if (!hit) setExtra((x) => [...x, t]);
    setOpen(hit || t);
    if (scroll) setScrollTo(hit || t);
  };

  // Deep link from the Live board: open once, then clear so a later visit doesn't reopen it.
  useEffect(() => {
    if (loading || !deepLink) return;
    openFor(deepLink, true);
    setState({ driversOpen: null });
  }, [loading, deepLink]);

  useEffect(() => {
    if (!scrollTo) return;
    const el = document.querySelector(`[data-dv="${CSS.escape(fold(scrollTo))}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
    setScrollTo(null);
  }, [scrollTo, open]);

  const onSaved = (doc) => { setPrefs(doc.drivers); setOpen(null); };

  const qq = fold(q);
  const rows = allNames().filter((n) => n === open
    || ((!qq || fold(n).includes(qq)) && (!onlyPrefs || normPref(prefOf(n)))));
  const nWith = allNames().filter((n) => normPref(prefOf(n))).length;

  const add = (e) => {
    e.preventDefault();
    openFor(addName, true);
    setAddName('');
  };

  return html`<div class="card">
    <p class="hint">Set what each driver can work. The weekly build follows these: days they can't work become Unavailable, and the limits are never broken. On the Live board, going past a limit shows a yellow warning.</p>
    <div class="row dv-tools">
      <input type="text" class="dv-search" placeholder="Search a name" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search a name" />
      <label class="dv-check"><input type="checkbox" checked=${onlyPrefs} onChange=${(e) => setOnlyPrefs(e.target.checked)} />
        Only drivers with preferences${loading ? '' : ` (${nWith})`}</label>
    </div>

    ${loading ? html`<div class="dv-loading"><${Spinner}/> Loading drivers…</div>` : html`
      ${rows.length ? html`<div class="dv-list">${rows.map((n) => {
        const p = normPref(prefOf(n));
        const chips = prefSummary(p);
        const isOpen = n === open;
        const toggle = () => setOpen(isOpen ? null : n);
        return html`<div class=${'dv-item' + (isOpen ? ' open' : '')} data-dv=${fold(n)} key=${n}>
          <div class="dv-row" role="button" tabIndex="0" aria-expanded=${isOpen} onClick=${toggle}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
            <span class="dv-name">${n}</span>
            <span class="dv-chips">${chips.length
              ? chips.map((c) => html`<span class="chip blue">${c}</span>`)
              : html`<span class="muted small">No preferences</span>`}</span>
            ${p && p.note ? html`<span class="muted small dv-note-txt">${p.note}</span>` : ''}
          </div>
          ${isOpen ? html`<${Editor} key=${'ed-' + n} name=${n} pref=${prefOf(n)} onSaved=${onSaved} onClose=${() => setOpen(null)} />` : ''}
        </div>`;
      })}</div>`
      : html`<p class="muted">${allNames().length ? 'No drivers match.' : 'No drivers found yet.'}</p>`}

      <form class="row dv-add" onSubmit=${add}>
        <span class="muted small">Add someone not on the list</span>
        <input type="text" placeholder="Full name" value=${addName} onInput=${(e) => setAddName(e.target.value)} aria-label="Name to add" />
        <button class="small" disabled=${!addName.trim()}>Add</button>
      </form>`}
  </div>`;
}

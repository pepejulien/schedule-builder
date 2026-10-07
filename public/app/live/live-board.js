// The Live board (2026-10-06): the published week, worked day to day. Every
// login with the Schedule Builder can change it; every change is saved to
// Firestore as one transaction with a line in the week's change log.
//
// Rules are the builder's own (runner.py _assess): green = safe, yellow =
// policy (allowed, flagged), red = they asked the day off (typed confirm),
// grey = compliance (locked). Hours are SCHEDULED hours on the clock (route
// 10h, backup 2h, meeting 2h, dispatch 12h). Here only, a 6-day and overtime
// go through after a pop-up (orange); 12h a day / 60h in 7 days / 7 in a row
// stay locked. Cells use Amazon's own shift colors (2026-10-06).
import { html } from '../preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { setState, setWizard, toast } from '../store.js';
import { Banner, Spinner, Icon, download } from '../ui.js';
import { liveRequest } from '../solver-client.js';
import { canLive, liveWeeks, liveWeek, watchLiveWeek, watchLiveLog } from '../api.js';
import { driverCsv } from '../lib/driver-csv.js';
import { parseISODate } from '../lib/weeks.js';
import {
  WaveEditor, SlotEditor, ConfirmOverride, LimitConfirm, runConfirmed, TIER_META, TIER_ORDER,
  translateInfeasible, translateOverride,
} from '../steps/step9-build.js';
import {
  loadEngine, saveWeek, logLines, summaryFromReport, sundayOf, todayISO, cellInfo,
  WAVE_COLORS, SHIFT_COLORS,
} from './live-model.js';
import { parseISODate as pd, toISODate, addDays } from '../lib/weeks.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MUT = new Set(['apply', 'apply_add', 'apply_wave', 'undo', 'apply_mark', 'clear_mark', 'set_role']);
const KIND = { apply: 'edit', apply_add: 'extra', apply_wave: 'wave', undo: 'undo', apply_mark: 'mark', clear_mark: 'mark',
  set_role: 'edit' };
const MARKS = [
  ['callout', 'Called out', 'They called in and won\'t work.'],
  ['noshow', 'No-show', 'They didn\'t show up and didn\'t call.'],
  ['off', 'Day off', 'They asked for the day off during the week.'],
];

// Name search ignores case and accents ("jose" finds "José").
const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// The sort choice is a per-device convenience (Jose 2026-10-06).
const SORT_KEY = 'lv_sort';
const readSort = () => { try { return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'tier'; } catch { return 'tier'; } };
const saveSort = (v) => { try { localStorage.setItem(SORT_KEY, v); } catch { /* private window */ } };

// Sum of on-the-clock hours over the 7 days ending `endISO`.
function last7(dayHours, endISO) {
  let t = 0;
  for (let k = 0; k < 7; k++) t += Number((dayHours || {})[toISODate(addDays(pd(endISO), -k))] || 0);
  return t;
}

// A grid cell drawn the way Amazon's scheduling page does: a colored block,
// the time on top, the role (Backup / Trainer / Trainee) under it.
function Block({ v }) {
  const c = cellInfo(v);
  if (c.kind === 'empty') return '';
  return html`<div class=${'lv-blk b-' + c.kind} style=${c.bg ? `background:${c.bg}` : ''}>
    <span>${c.top}</span>${c.sub ? html`<small>${c.sub}</small>` : ''}</div>`;
}

// "P1 INFEASIBLE Tue: filled 5/6" -> plain words for a week already running
function openText(line) {
  let m = line.match(/P1 INFEASIBLE (\w+): filled (\d+)\/(\d+)/);
  if (m) { const n = m[3] - m[2]; return `${m[1]}: ${n} route${n === 1 ? '' : 's'} open (${m[2]} of ${m[3]} filled).`; }
  m = line.match(/P2 SHORT (\w+): (\d+)\/(\d+)/);
  if (m) { const n = m[3] - m[2]; return `${m[1]}: ${n} backup${n === 1 ? '' : 's'} open (${m[2]} of ${m[3]} filled).`; }
  return translateInfeasible(line);
}

const shortDate = (iso) => { const d = parseISODate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US',
  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'just now');

function NotHere() {
  return html`<div class="card hero">
    <div class="hero-ico">${Icon('live', 24)}</div>
    <h2>The Live board runs on the JAJB site</h2>
    <p class="hint">Open <a href="https://jajb-ops.web.app/schedule/">jajb-ops.web.app/schedule/</a> — published weeks,
      midweek changes and their history are saved there, shared by everyone with the Schedule Builder.</p>
  </div>`;
}

// "10:05 AM" < "10:25 AM" < "1:05 PM"
const waveMins = (w) => { const m = String(w).match(/(\d{1,2}):(\d{2}) ([AP]M)/); if (!m) return 9999;
  return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2]; };

// Routes driven per wave on a day, from the grid (trainees drive).
function waveFills(view, day) {
  const out = {};
  for (const x of view.drivers) {
    const c = cellInfo((x.cells || {})[day]);
    if (c.kind === 'road' || c.kind === 'trainee') out[c.top] = (out[c.top] || 0) + 1;
  }
  return out;
}

// Jose 2026-10-06: clicking a day shows THAT day's waves right away — one
// click puts the driver on a route there. A full wave is fine: it just gets
// one more route (Amazon may have handed out routes the app doesn't know
// yet). Rule results show up front; pop-ups still come where they're needed.
function DayShifts({ name, info, road, fills, busy, onPick, compact }) {
  const first = name.split(/\s+/)[0];
  if (!road) return html`<p class="muted"><${Spinner}/> Checking the rules…</p>`;
  if (road.status === 'blocked') {
    return html`<div class="lv-lock">🔒 Can't put ${first} on a route${compact ? '' : ` ${info.day}`}: ${road.reasons.join('; ')}</div>`;
  }
  const waves = Object.keys(info.waves || {}).sort((a, b) => waveMins(a) - waveMins(b));
  const warns = road.status === 'warn' || road.status === 'full'
    ? road.reasons.filter((r) => !/^(6-day|overtime)/.test(r)) : [];
  return html`<div class="lv-dayshifts">
    ${road.status === 'unavail' ? html`<div class="lv-note unavail">${first} asked for this day off — you'll confirm before it's saved.</div>` : ''}
    ${(road.limits || []).length ? html`<div class="lv-note confirm">${road.limits.join('; ')} — a pop-up will ask you first.</div>` : ''}
    ${warns.length ? html`<div class="lv-note warn">Allowed, but flagged: ${warns.join('; ')}</div>` : ''}
    ${!compact ? html`<div class="muted" style="margin:6px 0 4px">Put ${first} on a route:</div>` : ''}
    <div class="lv-wavebtns">
      ${waves.map((w) => {
        const want = info.waves[w] || 0, got = fills[w] || 0;
        const full = got >= want;
        return html`<button class="lv-wavebtn" disabled=${busy} style=${`background:${WAVE_COLORS[w.replace(/ [AP]M$/, '')] || SHIFT_COLORS.other}`}
          aria-label=${`${w}: ${full ? 'full, adds one more route' : `${got} of ${want} filled`}`}
          title=${full ? `All ${want} route${want === 1 ? '' : 's'} in this wave ${want === 1 ? 'is' : 'are'} filled — this adds one more` : `${got} of ${want} filled`}
          onClick=${() => onPick(w)}><b>${w}</b><small>${full ? 'full · +1 route' : `${got} of ${want} filled`}</small></button>`;
      })}
      ${!waves.length ? html`<span class="muted">No waves set for this day.</span>` : ''}
    </div>
  </div>`;
}

// What one driver is doing on one day, and what can be done about it.
function CellMenu({ d, day, info, mark, busy, onClose, act, road, fills }) {
  const v = (d.cells || {})[day] || '';
  const c = cellInfo(v);
  const kind = c.kind;
  const role = kind === 'road' ? 'road' : kind === 'bk' ? 'backup' : null;
  const first = d.name.split(/\s+/)[0];
  const date = parseISODate(info.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>${d.name} — ${date}</h3>
      <p class="hint">Now: <b>${kind === 'trainer' ? `Trainer — rides along with ${c.partner}, ${c.top}`
        : kind === 'trainee' ? `Trainee — drives ${c.top} with trainer ${c.partner}` : (v || 'not scheduled')}</b>
        · ${d.clock_hours ?? d.hours}h this week · most in any 7 days ${d.max7 ?? '—'}h · ${d.streak} day${d.streak === 1 ? '' : 's'} in a row (longest)</p>
      ${mark ? html`<${Banner} kind="warn"><b>${c.top}</b>${mark.was ? ` — was a ${mark.was}` : ''}${mark.note ? ` · “${mark.note}”` : ''}<//>` : ''}
      ${!info.open ? html`<p class="muted">The station is closed this day.</p>` : ''}
      <div class="lv-actions">
        ${role ? html`
          <button disabled=${busy} onClick=${() => act('move', { day, role, fromName: d.name })}>Give this ${role === 'road' ? 'route' : 'backup'} to someone else…</button>
          <button disabled=${busy} onClick=${() => act('wave', { day, name: d.name })}>Change wave…</button>
          ${role === 'road'
            ? html`<button disabled=${busy} onClick=${() => act('role', { name: d.name, day, to: 'backup' })}>Make it a backup (the route stays open)</button>`
            : html`<button disabled=${busy} onClick=${() => act('role', { name: d.name, day, to: 'road' })}>Make it a route</button>`}
          <button disabled=${busy} onClick=${() => act('mark', { name: d.name, day, kind: 'callout' })}>${first} called out…</button>
          <button disabled=${busy} onClick=${() => act('mark', { name: d.name, day, kind: 'noshow' })}>No-show…</button>
          <button disabled=${busy} onClick=${() => act('remove', { day, role, fromName: d.name })}>Remove — leave the slot open</button>` : ''}
        ${mark ? html`<button disabled=${busy} onClick=${() => act('clear', { name: d.name, day })}>Clear this mark</button>` : ''}
        ${info.open && (kind === 'empty' || kind === 'off') ? html`
          <${DayShifts} name=${d.name} info=${info} road=${road} fills=${fills} busy=${busy}
            onPick=${(w) => act('wave-add', { name: d.name, day, wave: w, road })} />` : ''}
        ${info.open && kind === 'empty' ? html`
          <button disabled=${busy} onClick=${() => act('mark', { name: d.name, day, kind: 'off' })}>${first} asked for ${day} off…</button>` : ''}
        ${kind === 'trainer' || kind === 'trainee' ? html`<p class="muted">Training day — change it with a rebuild in the builder.</p>` : ''}
        ${kind === 'disp' || kind === 'meet' ? html`<p class="muted">Dispatch duty / meetings come from the builder's settings.</p>` : ''}
      </div>
      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Close</button>
        ${busy ? html`<span><${Spinner}/> Saving…</span>` : ''}
      </div>
    </div>
  </div>`;
}

// Click on a name: the driver's week, each free day with its waves.
function WeekShifts({ d, view, opts, busy, onClose, onPick }) {
  const first = d.name.split(/\s+/)[0];
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>Give ${d.name} a shift</h3>
      <p class="hint">${d.clock_hours ?? d.hours}h this week · most in any 7 days ${d.max7 ?? '—'}h. Pick a wave on a free day —
        a full wave just gets one more route. To make a backup, click the shift in the table afterwards.</p>
      ${opts && opts.error ? html`<${Banner} kind="err">${opts.error.message}<//>` : ''}
      <div class="lv-week">
        ${view.days.filter((x) => x.open).map((info) => {
          const v = (d.cells || {})[info.day] || '';
          const k = cellInfo(v).kind;
          const dd = opts && opts.data ? opts.data.days.find((x) => x.day === info.day) : null;
          return html`<div class="lv-weekrow">
            <div class="lv-weekday"><b>${info.day}</b> <span class="muted">${shortDate(info.date)}</span></div>
            <div>${k !== 'empty' && k !== 'off'
              ? html`<div style="max-width:150px"><${Block} v=${v} /></div>`
              : html`<${DayShifts} compact name=${d.name} info=${info} road=${dd ? dd.road : null}
                  fills=${waveFills(view, info.day)} busy=${busy} onPick=${(w) => onPick(info.day, w, dd && dd.road)} />`}</div>
          </div>`;
        })}
      </div>
      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Close</button>
        ${busy ? html`<span><${Spinner}/> Saving…</span>` : ''}
      </div>
    </div>
  </div>`;
}

function MarkDialog({ req, busy, onClose, onSave }) {
  const [kind, setKind] = useState(req.kind);
  const [note, setNote] = useState('');
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>${req.name} — ${req.day}</h3>
      <p class="hint">Their shift that day comes off and the slot shows as <b>open</b>, so you can fill it.
        The day then counts as a day off for the rules.</p>
      ${MARKS.map(([k, label, sub]) => html`<label class="row lv-radio">
        <input type="radio" name="mk" checked=${kind === k} onChange=${() => setKind(k)} />
        <span><b>${label}</b> <span class="muted">${sub}</span></span></label>`)}
      <label class="fld" style="margin-top:10px"><span>Note (optional)</span>
        <input type="text" maxlength="200" value=${note} onInput=${(e) => setNote(e.target.value)}
          placeholder="e.g. sick, family emergency" style="width:100%" /></label>
      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
        <button class="primary" disabled=${busy} onClick=${() => onSave(kind, note)}>Save</button>
        ${busy ? html`<span><${Spinner}/> Saving…</span>` : ''}
      </div>
    </div>
  </div>`;
}

// "Who can work extra?" — every driver checked against the rules for one
// day and role, safest first.
function Finder({ view, finder, setFinder, ready, rev, busy, onPick }) {
  const [st, setSt] = useState(null);
  const days = view.days.filter((x) => x.open);
  const info = view.days.find((x) => x.day === finder.day);
  useEffect(() => {
    if (!ready || !finder.day) { setSt(null); return undefined; }
    let alive = true;
    setSt({ loading: true });
    liveRequest('candidates', { day: finder.day, role: finder.role }).then((m) => {
      if (alive) setSt(m.ok ? { list: m.data.candidates } : { error: m.error.message });
    });
    return () => { alive = false; };
  }, [ready, rev, finder.day, finder.role]);

  const open = info ? (finder.role === 'road' ? info.routes - info.routes_filled : info.backup - info.backup_filled) : 0;
  const list = (st && st.list) || [];
  const groups = [['ok', 'Can work — no rule breaks'], ['warn', 'Can work — breaks a company policy (flagged)'],
    ['confirm', '6-day / overtime — can work after a pop-up'],
    ['unavail', 'Asked for the day off — needs your confirmation'],
    ['blocked', 'Can\'t — compliance rule (12h a day, 60h in 7 days, 7 in a row, clashes)']];
  const [showBlocked, setShowBlocked] = useState(false);
  return html`<div class="card" id="lv-finder">
    <h2>Who can work extra?</h2>
    <div class="row" style="margin:8px 0">
      <select value=${finder.day || ''} onChange=${(e) => setFinder({ ...finder, day: e.target.value })}>
        ${days.map((x) => html`<option value=${x.day}>${x.day} ${shortDate(x.date)}</option>`)}
      </select>
      <select value=${finder.role} onChange=${(e) => setFinder({ ...finder, role: e.target.value })}>
        <option value="road">a route</option><option value="backup">a backup</option>
      </select>
      ${info ? html`<span class=${open > 0 ? 'lv-open' : 'muted'}>${open > 0
        ? `${open} open ${finder.role === 'road' ? 'route' : 'backup'}${open === 1 ? '' : 's'} on ${finder.day}`
        : `${finder.day}'s ${finder.role === 'road' ? `${info.routes} routes` : `${info.backup} backups`} are all filled`}</span>` : ''}
    </div>
    ${!ready ? html`<p class="muted"><${Spinner}/> Loading the rules engine…</p>` : ''}
    ${st && st.loading ? html`<p class="muted"><${Spinner}/> Checking every driver…</p>` : ''}
    ${st && st.error ? html`<${Banner} kind="err">${st.error}<//>` : ''}
    ${groups.map(([status, label]) => {
      const g = list.filter((c) => c.status === status);
      if (!g.length) return '';
      if (status === 'blocked' && !showBlocked) {
        return html`<p class="muted"><button class="link" onClick=${() => setShowBlocked(true)}>Show the ${g.length} who can't (and why)</button></p>`;
      }
      return html`<div class="cand-group">
        <h4 class=${'cand-h ' + status}>${label} (${g.length})</h4>
        ${g.map((c) => {
          const meta = TIER_META[c.cls] || TIER_META.free;
          return html`<div class=${'cand ' + status}>
            <button class="cand-pick" disabled=${busy || status === 'blocked'}
              onClick=${() => onPick(c, open > 0)}>${status === 'blocked' ? '🔒 ' : '+ '}${c.name}</button>
            <span class="chip ${meta.chip}">${meta.short}</span>
            <span class="cand-hours"><b>${c.road_days.length + c.backup_days.length} days</b> · ${c.hours}h → ${c.new_hours}h</span>
            ${(c.reasons || []).length ? html`<div class="cand-why">${c.reasons.join('; ')}</div>` : ''}
            ${(c.notes || []).length ? html`<div class="cand-note">${c.notes.join('; ')}</div>` : ''}
          </div>`;
        })}
      </div>`;
    })}
  </div>`;
}

export function LiveBoard() {
  if (!canLive()) return html`<${NotHere} />`;
  return html`<${Board} />`;
}

function Board() {
  const [weeks, setWeeks] = useState(null);
  const [sel, setSel] = useState(null);
  const [data, setData] = useState(null);      // {meta, summary, engineJson, rev}
  const [rep, setRep] = useState(null);        // the engine's report for data.rev
  const [eng, setEng] = useState({ status: 'idle', rev: null, error: null });
  const [metaLive, setMetaLive] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [cell, setCell] = useState(null);      // {name, day}
  const [adder, setAdder] = useState(null);    // {name}
  const [waver, setWaver] = useState(null);    // {day, name}
  const [mover, setMover] = useState(null);    // {day, role, fromName}
  const [moverCands, setMoverCands] = useState(null);
  const [marker, setMarker] = useState(null);  // {name, day, kind}
  const [confirm, setConfirm] = useState(null);
  const [limit, setLimit] = useState(null);     // the 6-day / overtime pop-up
  const [opts, setOpts] = useState(null);       // add_options for the driver whose day/week is open
  const [finder, setFinder] = useState({ day: null, role: 'road' });
  const [showLog, setShowLog] = useState(false);
  const [sortBy, setSortBy] = useState(readSort);   // 'tier' | 'name'
  const [q, setQ] = useState('');                   // name search

  // async work reads the newest values through refs
  const R = useRef({});
  Object.assign(R.current, { sel, data, rep, eng, metaLive, busy });
  const saving = useRef(false);

  async function refreshWeeks(pick) {
    try {
      const ws = await liveWeeks(80);
      setWeeks(ws);
      if (pick) {
        const t = sundayOf(todayISO());
        setSel((ws.find((w) => w.week === t) || ws[0] || {}).week || null);
      }
    } catch (e) { setErr('Could not read the published weeks: ' + (e.message || e)); setWeeks([]); }
  }
  useEffect(() => { refreshWeeks(true); }, []);

  async function openWeek(week) {
    try {
      const d = await liveWeek(week);
      if (R.current.sel !== week) return;
      if (!d) { setErr('That week is no longer on the Live board.'); return; }
      const nd = { meta: d.meta, summary: JSON.parse(d.summary), engineJson: d.engine, rev: d.meta.rev };
      setData(nd); R.current.data = nd;
      setRep(null);
      setEng({ status: 'loading', rev: null, error: null });
      const r = await loadEngine(week, d.engine);
      if (R.current.sel !== week || R.current.data !== nd) return;
      setRep(r); R.current.rep = r;
      setEng({ status: 'ready', rev: nd.rev, error: null }); R.current.eng = { status: 'ready', rev: nd.rev };
    } catch (e) {
      setEng({ status: 'error', rev: null, error: e.message || String(e) });
    }
  }

  useEffect(() => {
    if (!sel) return undefined;
    setData(null); setRep(null); setLog([]); setErr(''); setMetaLive(null);
    setEng({ status: 'idle', rev: null, error: null });
    openWeek(sel);
    const un1 = watchLiveWeek(sel, (m) => setMetaLive(m));
    const un2 = watchLiveLog(sel, (l) => setLog(l));
    return () => { un1(); un2(); };
  }, [sel]);

  // someone else saved this week: pull it in
  useEffect(() => {
    const d = R.current.data;
    if (!metaLive || !d || saving.current) return;
    if (metaLive.rev > d.rev) {
      toast(`${metaLive.by || 'Someone'} changed this week — showing the latest.`);
      openWeek(R.current.sel);
    }
  }, [metaLive && metaLive.rev]);

  // the finder starts on today (or the first open day)
  useEffect(() => {
    if (!data || finder.day) return;
    const days = (data.summary.days || []).filter((x) => x.open);
    const t = days.find((x) => x.date === todayISO()) || days.find((x) => x.date > todayISO()) || days[0];
    if (t) setFinder((f) => ({ ...f, day: t.day }));
  }, [data]);

  // One change, end to end: engine -> Firestore (+ change-log lines). The
  // engine must hold exactly the saved version first; a save that fails
  // (someone else saved first, or no signal) reloads the saved version so
  // nothing unsaved lingers on screen.
  async function run(op, payload) {
    const d = R.current.data;
    if (!d) return { ok: false, error: { kind: 'busy', message: 'The week is still loading.' } };
    if (R.current.busy) return { ok: false, error: { kind: 'busy', message: 'Still saving the last change…' } };
    setBusy(true); R.current.busy = true; saving.current = true;
    try {
      if (R.current.eng.status !== 'ready' || R.current.eng.rev !== d.rev) {
        const r0 = await loadEngine(R.current.sel, d.engineJson);
        setRep(r0); R.current.rep = r0;
        R.current.eng = { status: 'ready', rev: d.rev }; setEng({ status: 'ready', rev: d.rev, error: null });
      }
      const before = (R.current.rep && R.current.rep.edits) || [];
      const m = await liveRequest(op, payload);
      if (!m.ok) return m;
      let saved;
      try {
        saved = await saveWeek({ weekISO: R.current.sel, meta: d.meta, report: m.report, expectRev: d.rev,
          log: logLines(before, m.report.edits, KIND[op] || 'edit') });
      } catch (e) {
        const msg = e.code === 'conflict'
          ? `${e.message} The page now shows the latest version — make your change again if it's still needed.`
          : `Not saved — ${e.message || e}. Check the connection and try again.`;
        toast(msg, e.code === 'conflict' ? 'warn' : 'err');
        saving.current = false;
        await openWeek(R.current.sel);
        return { ok: false, error: { kind: 'save', message: msg } };
      }
      const nd = { meta: { ...d.meta, rev: saved.rev }, summary: summaryFromReport(m.report, d.meta),
        engineJson: saved.engine, rev: saved.rev };
      setData(nd); R.current.data = nd;
      setRep(m.report); R.current.rep = m.report;
      R.current.eng = { status: 'ready', rev: saved.rev }; setEng({ status: 'ready', rev: saved.rev, error: null });
      const lines = logLines(before, m.report.edits, KIND[op]);
      toast('Saved — ' + lines[lines.length - 1].text);
      return m;
    } catch (e) {
      return { ok: false, error: { kind: 'crash', message: e.message || String(e) } };
    } finally {
      setBusy(false); R.current.busy = false; saving.current = false;
      // a save from someone else that landed while ours was in flight
      const ml = R.current.metaLive, dd = R.current.data;
      if (ml && dd && ml.rev > dd.rev) openWeek(R.current.sel);
    }
  }
  const req = (op, p) => (MUT.has(op) ? run(op, p) : liveRequest(op, p));

  // rule check of every day for the driver whose cell / week is open
  const optName = (cell && cell.name) || (adder && adder.name) || null;
  useEffect(() => {
    if (!optName || !data) { setOpts(null); return undefined; }
    let alive = true;
    setOpts({ loading: true });
    const go = () => liveRequest('add_options', { name: optName }).then((m) => {
      if (alive) setOpts(m.ok ? { data: m.data } : { error: m.error });
    });
    if (R.current.eng.status === 'ready') go();
    else { const t = setInterval(() => { if (R.current.eng.status === 'ready') { clearInterval(t); go(); } }, 300);
      return () => { alive = false; clearInterval(t); }; }
    return () => { alive = false; };
  }, [optName, data && data.rev, eng.status]);

  // A route in a chosen wave, through whatever pop-ups it needs.
  function addWave(name, day, wave, road) {
    runConfirmed({ name, day, role: 'road', unavReasons: road && road.status === 'unavail' ? road.reasons : null,
      limits: road && road.limits }, setConfirm, setLimit, async (flags) => {
      const m = await run('apply_add', { name, day, role: 'road', wave, ...flags });
      if (m.ok) { setCell(null); setAdder(null); } else toast(m.error.message, 'err');
    });
  }

  // Any edit; if the engine asks for a pop-up first, show it and try again.
  async function runAsking(op, payload, who) {
    const m = await run(op, payload);
    if (m.ok || !m.error) return m;
    if (m.error.kind === 'needs_confirm') {
      setConfirm({ ...who, reasons: [m.error.message.replace(/ Confirm the override first\.$/, '')],
        run: () => runAsking(op, { ...payload, confirm_unavailable: true }, who) });
    } else if (m.error.kind === 'needs_limits') {
      setLimit({ ...who, limits: m.error.limits || [], run: () => runAsking(op, { ...payload, confirm_limits: true }, who) });
    } else toast(m.error.message, 'err');
    return m;
  }

  // candidates for "give this shift to someone else"
  useEffect(() => {
    if (!mover) { setMoverCands(null); return undefined; }
    let alive = true;
    setMoverCands({ loading: true, error: null, list: null });
    liveRequest('candidates', { day: mover.day, role: mover.role, from_name: mover.fromName }).then((m) => {
      if (alive) setMoverCands(m.ok ? { loading: false, error: null, list: m.data.candidates } : { loading: false, error: m.error, list: null });
    });
    return () => { alive = false; };
  }, [mover]);

  function moveTo(toName) {
    const c = toName && moverCands && moverCands.list ? moverCands.list.find((x) => x.name === toName) : null;
    const go = async (flags) => {
      const m = await run('apply', { day: mover.day, role: mover.role, from_name: mover.fromName,
        to_name: toName, ...flags });
      if (m.ok) setMover(null);
      else setMoverCands((s) => ({ ...(s || {}), loading: false, error: m.error }));
    };
    if (!c) { go({}); return; }
    runConfirmed({ name: toName, day: mover.day, role: mover.role,
      unavReasons: c.status === 'unavail' ? c.reasons : null, limits: c.limits }, setConfirm, setLimit, go);
  }

  // a pick from "Who can work extra?"
  function finderPick(c, hasOpen) {
    const { day, role } = finder;
    // a full day just gets one more route (Jose 2026-10-06: Amazon may have
    // handed out routes the app doesn't know yet) — the change log says so
    runConfirmed({ name: c.name, day, role, unavReasons: c.status === 'unavail' ? c.reasons : null, limits: c.limits },
      setConfirm, setLimit, async (flags) => {
        const m = hasOpen ? await run('apply', { day, role, to_name: c.name, ...flags })
          : await run('apply_add', { name: c.name, day, role, ...(role === 'road' ? { extra_route: true } : {}), ...flags });
        if (!m.ok) toast(m.error.message, 'err');
      });
  }

  async function cellAct(what, p) {
    if (what !== 'wave-add') setCell(null);
    if (what === 'move') setMover(p);
    else if (what === 'wave') setWaver(p);
    else if (what === 'mark') setMarker(p);
    else if (what === 'add') setAdder(p);
    else if (what === 'wave-add') addWave(p.name, p.day, p.wave, p.road);
    else if (what === 'role') runAsking('set_role', p, { name: p.name, day: p.day, role: p.to === 'road' ? 'road' : 'backup' });
    else if (what === 'remove') {
      const m = await run('apply', { day: p.day, role: p.role, from_name: p.fromName });
      if (!m.ok) toast(m.error.message, 'err');
    } else if (what === 'clear') {
      const m = await run('clear_mark', p);
      if (!m.ok) toast(m.error.message, 'err');
    }
  }

  async function downloadXlsx() {
    if (R.current.eng.status !== 'ready') { toast('The engine is still loading — try again in a few seconds.', 'warn'); return; }
    const m = await liveRequest('export_xlsx', {});
    if (!m.ok || !m.xlsx) { toast(m.error ? m.error.message : 'No workbook came back.', 'err'); return; }
    download(m.xlsx, `Week-${data.meta.num}-Schedule.xlsx`, XLSX_MIME);
  }

  // ------------------------------------------------------------- render --
  if (weeks === null) return html`<div class="card"><${Spinner}/> Loading the published weeks…</div>`;
  if (!weeks.length) {
    return html`<div class="card hero">
      <div class="hero-ico">${Icon('live', 24)}</div>
      <h2>No published weeks yet</h2>
      <p class="hint">Build a schedule, then press <b>Publish to the Live board</b> on the Build step. The week then
        lives here: everyone with the Schedule Builder can work it during the week, and every change is logged.</p>
      ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
      <button class="accent" onClick=${() => { setState({ route: 'wizard' }); setWizard({ step: 4 }); }}>Go to Build ${Icon('arrow', 16)}</button>
    </div>`;
  }

  const idx = weeks.findIndex((w) => w.week === sel);
  const thisWeek = sundayOf(todayISO());
  const picker = html`<div class="card lv-head">
    <div class="row">
      <button class="small" disabled=${idx >= weeks.length - 1} title="Older week" onClick=${() => setSel(weeks[idx + 1].week)}>◀</button>
      <select value=${sel || ''} onChange=${(e) => setSel(e.target.value)}>
        ${weeks.map((w) => html`<option value=${w.week}>${w.label || w.week}${w.week === thisWeek ? ' — this week' : w.week > thisWeek ? ' — upcoming' : ''}</option>`)}
      </select>
      <button class="small" disabled=${idx <= 0} title="Newer week" onClick=${() => setSel(weeks[idx - 1].week)}>▶</button>
      <span class="muted lv-pub">${data ? `Published by ${data.meta.publishedBy || '—'} · last change by ${data.meta.by || '—'}` : ''}</span>
    </div>
  </div>`;

  if (!data) {
    return html`<div>${picker}
      ${err ? html`<${Banner} kind="err">${err}<//>` : html`<div class="card"><${Spinner}/> Loading the week…</div>`}</div>`;
  }

  const view = rep ? summaryFromReport(rep, data.meta) : data.summary;
  const ready = eng.status === 'ready' && eng.rev === data.rev;
  const today = todayISO();
  const tday = view.days.find((x) => x.date === today);
  const lim = view.limits || {};
  const openRoutes = view.days.filter((x) => x.open).reduce((a, x) => a + Math.max(0, x.routes - x.routes_filled), 0);
  const openBk = view.days.filter((x) => x.open).reduce((a, x) => a + Math.max(0, x.backup - x.backup_filled), 0);
  const byName = Object.fromEntries(view.drivers.map((x) => [x.name, x]));
  const markOf = (name, day) => (view.marks || []).find((x) => x.name === name && x.day === day);
  // search + sort: by tier (Top/Solid first, as the builder groups them) or A-Z
  const shown = view.drivers.filter((x) => !q.trim() || fold(x.name).includes(fold(q.trim())));
  const groups = sortBy === 'name'
    ? [{ key: 'all', rows: shown.slice().sort((a, b) => a.name.localeCompare(b.name)) }]
    : TIER_ORDER.map((t) => ({ key: t, meta: TIER_META[t], rows: shown.filter((x) => x.cls === t) }))
      .filter((g) => g.rows.length);
  const todayCount = tday ? view.drivers.reduce((a, x) => {
    const k = cellInfo((x.cells || {})[tday.day]).kind;
    return a + (k === 'road' || k === 'trainee' ? 1 : 0);
  }, 0) : null;

  const max7Lim = lim.max_7day_hours || 60;
  const hoursCls = (h) => (h > max7Lim ? 'lv-bad' : lim.weekly_hours_cap && h > lim.weekly_hours_cap ? 'lv-warn' : '');
  const max7Cls = (h) => (h > max7Lim ? 'lv-bad' : h >= max7Lim - 6 ? 'lv-warn' : '');
  // "Last 7d" like Amazon: the 7 days ending today, or ending the week's last
  // day for a week that's over (an upcoming week shows its busiest 7 days)
  const lastDay = view.days[view.days.length - 1].date;
  const endISO = today < view.days[0].date ? null : today > lastDay ? lastDay : today;
  const streakCls = (n) => (n > (lim.max_consecutive || 5) ? 'lv-bad' : n === (lim.max_consecutive || 5) ? 'lv-warn' : '');
  const daysCls = (n) => (n > (lim.max_worked_days || 5) ? 'lv-bad' : n === (lim.max_worked_days || 5) ? 'lv-warn' : '');
  const goFind = (day, role) => {
    setFinder({ day, role });
    setTimeout(() => { const el = document.getElementById('lv-finder'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 30);
  };
  const canUndo = ready && rep && rep.can_undo;

  return html`<div>
    ${picker}

    <div class="stats">
      <div class="stat"><div class="big">${todayCount == null ? '—' : todayCount}</div>
        <div class="muted">${tday ? `on routes today (${tday.day})` : 'not this week'}</div></div>
      <div class="stat"><div class=${'big' + (openRoutes ? ' lv-bad' : '')}>${openRoutes}</div><div class="muted">open routes this week</div></div>
      <div class="stat"><div class=${'big' + (openBk ? ' lv-warnc' : '')}>${openBk}</div><div class="muted">open backups</div></div>
      <div class="stat"><div class="big">${log.length}</div><div class="muted">changes logged</div></div>
    </div>

    ${eng.status === 'error' ? html`<${Banner} kind="err">The rules engine didn't load: ${eng.error}
      <div><button class="small" onClick=${() => openWeek(sel)}>Try again</button></div><//>` : ''}
    ${(view.infeasible || []).length ? html`<${Banner} kind="warn"><b>Open slots:</b>
      <ul>${view.infeasible.map((l) => {
        let m = l.match(/P1 INFEASIBLE (\w+)/);
        const slot = m ? { day: m[1], role: 'road' } : (m = l.match(/P2 SHORT (\w+)/)) ? { day: m[1], role: 'backup' } : null;
        return html`<li>${openText(l)}${slot ? html` <button class="small" onClick=${() => goFind(slot.day, slot.role)}>Find someone…</button>` : ''}</li>`;
      })}</ul><//>` : ''}
    ${(view.errors || []).length ? html`<${Banner} kind="err"><b>Rule problems:</b>
      <ul>${view.errors.map((l) => html`<li>${l}</li>`)}</ul><//>` : ''}
    ${(view.overridden || []).length ? html`<details class="banner warn"><summary><b>${view.overridden.length} approved override${view.overridden.length === 1 ? '' : 's'}</b></summary>
      <ul>${view.overridden.map((l) => html`<li>${translateOverride(l)}</li>`)}</ul></details>` : ''}

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2>${data.meta.label}</h2>
          <p class="hint" style="margin-bottom:0">Click any day to change it — call-outs, moves, extra shifts. Click a name to give that
            driver another shift. Hours are scheduled hours (route ${lim.primary_hours || 10}h, backup ${lim.backup_hours || 2}h).
            ${!ready && eng.status !== 'error' ? html` <span class="muted"><${Spinner}/> loading the rules engine…</span>` : ''}</p>
        </div>
        <div class="row">
          ${canUndo ? html`<button class="small" disabled=${busy} onClick=${async () => { const m = await run('undo', {}); if (!m.ok) toast(m.error.message, 'err'); }}>Undo my last change</button>` : ''}
          <button class="small" disabled=${!ready} onClick=${downloadXlsx}>${Icon('download', 15)} Workbook</button>
          <button class="small" onClick=${() => download(new TextEncoder().encode(driverCsv(view, data.meta.label)).buffer,
            `Week-${data.meta.num}-Driver-Notices.csv`, 'text/csv')}>${Icon('download', 15)} Driver notices</button>
        </div>
      </div>

      <div class="row lv-tools">
        <input type="search" placeholder="Search a driver…" value=${q} onInput=${(e) => setQ(e.target.value)}
          aria-label="Search a driver by name" />
        <div class="seg" role="group" aria-label="Sort drivers">
          <button class=${sortBy === 'tier' ? 'on' : ''} onClick=${() => { setSortBy('tier'); saveSort('tier'); }}>By tier</button>
          <button class=${sortBy === 'name' ? 'on' : ''} onClick=${() => { setSortBy('name'); saveSort('name'); }}>A–Z</button>
        </div>
        ${q.trim() ? html`<span class="muted">${shown.length} of ${view.drivers.length} drivers</span>` : ''}
      </div>

      <div class="scroll-x lv-wrap"><table class="lv-grid">
        <thead><tr>
          <th class="lv-namecol">Driver</th>
          ${view.days.map((x) => html`<th class=${(x.date === today ? 'today ' : x.date < today ? 'past ' : '') + (x.open ? '' : 'closed')}>
            ${x.day} <span class="lv-date">${shortDate(x.date)}</span>
            ${x.open ? html`<div class="lv-fill">
              <span class=${x.routes_filled < x.routes ? 'lv-bad' : ''} title="routes filled / needed">${x.routes_filled}/${x.routes}</span>
              <span class=${x.backup_filled < x.backup ? 'lv-warnc' : ''} title="backups filled / needed"> · bk ${x.backup_filled}/${x.backup}</span></div>`
              : html`<div class="lv-fill">closed</div>`}</th>`)}
          <th title="On the clock this week (scheduled)">Week</th>
          <th title=${`Most hours on the clock in any 7 days in a row, last week included (max ${max7Lim}h)`}>Max 7d</th>
          <th title=${`Days worked this week (usual max ${lim.max_worked_days || 5}; a 6th needs the pop-up)`}>Days</th>
          <th title=${`Longest run of days in a row, last week included (max ${lim.max_consecutive || 5})`}>In a row</th>
        </tr></thead>
        <tbody>${!shown.length ? html`<tr><td colspan=${view.days.length + 5} class="muted" style="text-align:left">
            No driver matches “${q}”.</td></tr>` : ''}
          ${groups.map((g) => html`
            ${g.meta ? html`<tr class="tier-sep"><td colspan=${view.days.length + 5}><span class="chip ${g.meta.chip}">${g.meta.label}</span>
              <span class="muted"> · ${g.rows.length}</span></td></tr>` : ''}
            ${g.rows.map((x) => {
              const nWorked = (x.worked_dates || []).length;
              const tm = TIER_META[x.cls] || TIER_META.free;
              return html`<tr>
                <td class="lv-namecol"><button class="link lv-name" title=${'Give ' + x.name + ' a shift'}
                  onClick=${() => setAdder({ name: x.name })}>${x.name}</button>
                  ${sortBy === 'name' ? html` <span class="chip ${tm.chip} tier-mini">${tm.short}</span>` : ''}
                  ${(x.helper_days || []).length ? html` <span class="chip trainer-chip" title="Trains a new hire this week">Trainer</span>` : ''}
                  <div class="lv-sub">Week: ${x.clock_hours ?? x.hours}h${endISO && x.day_hours
                    ? html` · <span class=${max7Cls(last7(x.day_hours, endISO))}>Last 7d: ${last7(x.day_hours, endISO)}h</span>` : ''}</div></td>
                ${view.days.map((dd) => {
                  const v = (x.cells || {})[dd.day] || '';
                  const c = cellInfo(v);
                  return html`<td class=${'lv-cell k-' + c.kind + (dd.date === today ? ' today' : '') + (dd.open ? '' : ' closed')}
                    title=${c.partner ? `${v} — ${c.kind === 'trainer' ? 'training' : 'trainer'}: ${c.partner}` : v || (dd.open ? 'Not scheduled — click for options' : 'Closed')}
                    onClick=${dd.open ? () => setCell({ name: x.name, day: dd.day }) : undefined}><${Block} v=${v} /></td>`;
                })}
                <td class=${hoursCls(x.clock_hours ?? x.hours)}>${x.clock_hours ?? x.hours}h</td>
                <td class=${max7Cls(x.max7 ?? 0)}>${x.max7 ?? '—'}${x.max7 != null ? 'h' : ''}</td>
                <td class=${daysCls(nWorked)}>${nWorked}</td>
                <td class=${streakCls(x.streak)}>${x.streak}</td>
              </tr>`;
            })}`)}</tbody>
      </table></div>
      <div class="lv-legend">
        ${Object.entries(WAVE_COLORS).map(([w, bg]) => html`<span class="lv-sw" style=${`background:${bg}`}>${w}</span>`)}
        <span class="lv-sw" style=${`background:${WAVE_COLORS['10:25']}`}>10:25 <small>Backup</small></span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.trainer}`}>Trainer</span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.disp}`}>Dispatch</span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.meet}`}>Meeting</span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.off}`}>Unavailable</span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.mark}`}>Called out / No-show</span>
      </div>
      <p class="hint">Hours are scheduled on-the-clock hours. Orange = at or near a limit, red = over it.
        Locked: 12h in a day, ${max7Lim}h in any 7 days (last week counts), 7 days in a row. A 6-day or overtime
        goes through after a pop-up.</p>
    </div>

    <${Finder} view=${view} finder=${finder} setFinder=${setFinder} ready=${ready} rev=${data.rev} busy=${busy}
      onPick=${finderPick} />

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>Change log</h2>
        <button class="small" onClick=${() => setShowLog(!showLog)}>${showLog ? 'Show the last 8' : `Show all ${log.length}`}</button>
      </div>
      ${!log.length ? html`<p class="muted">No changes yet.</p>` : html`<ul class="lv-log">
        ${(showLog ? log : log.slice(0, 8)).map((l) => html`<li class=${'k-' + l.kind}>
          <span class="lv-when">${when(l.at)}</span> <b>${l.by || '—'}</b> — ${l.text}</li>`)}</ul>`}
    </div>

    ${cell && byName[cell.name] ? html`<${CellMenu} d=${byName[cell.name]} day=${cell.day}
      info=${view.days.find((x) => x.day === cell.day)} mark=${markOf(cell.name, cell.day)} busy=${busy}
      road=${opts && opts.data && opts.data.name === cell.name ? (opts.data.days.find((x) => x.day === cell.day) || {}).road : null}
      fills=${waveFills(view, cell.day)}
      onClose=${() => setCell(null)} act=${cellAct} />` : ''}
    ${marker ? html`<${MarkDialog} req=${marker} busy=${busy} onClose=${() => setMarker(null)}
      onSave=${async (kind, note) => { const m = await run('apply_mark', { ...marker, kind, note }); if (m.ok) setMarker(null); else toast(m.error.message, 'err'); }} />` : ''}
    ${mover ? html`<${SlotEditor} editor=${mover} cands=${moverCands} busy=${busy}
      onPick=${(n) => moveTo(n)} onClose=${() => setMover(null)}
      onRemove=${async () => { const m = await run('apply', { day: mover.day, role: mover.role, from_name: mover.fromName }); if (m.ok) setMover(null); }} />` : ''}
    ${waver ? html`<${WaveEditor} day=${waver.day} name=${waver.name} req=${req}
      onClose=${() => setWaver(null)} onApplied=${() => setWaver(null)} />` : ''}
    ${adder && byName[adder.name] ? html`<${WeekShifts} d=${byName[adder.name]} view=${view} busy=${busy}
      opts=${opts && (opts.error || (opts.data && opts.data.name === adder.name)) ? opts : null}
      onClose=${() => setAdder(null)} onPick=${(day, w, road) => addWave(adder.name, day, w, road)} />` : ''}
    ${confirm ? html`<${ConfirmOverride} req=${confirm} onCancel=${() => setConfirm(null)}
      onConfirm=${() => { const q = confirm; setConfirm(null); q.run(); }} />` : ''}
    ${limit ? html`<${LimitConfirm} req=${limit} onCancel=${() => setLimit(null)}
      onConfirm=${() => { const q = limit; setLimit(null); q.run(); }} />` : ''}
  </div>`;
}

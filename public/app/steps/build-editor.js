// Step 9 after the build (Jose 2026-10-23): everything for fixing the week by hand
// before it's published. "What's still open" per day with fill / extra buttons, a
// week grid like the Live board where any day opens its choices, trades between two
// drivers, someone missing from the week. Rules are the engine's own (runner.py
// _assess): green safe, yellow policy (flagged), orange a 6-day / overtime (a pop-up),
// red a day off (one-click confirm), grey locked (12h a day, 60h in 7 days, 7 in a row,
// clashes). The solver itself never bends a rule; only these hand edits do.
import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { getState, setWizard, toast } from '../store.js';
import { Banner, Spinner } from '../ui.js';
import { editRequest } from '../solver-client.js';
import { cellInfo, SHIFT_COLORS, WAVE_COLORS } from '../live/live-model.js';
import { CountsEditor, waveMins, waveBg } from '../live/counts-editor.js';
import { parseISODate } from '../lib/weeks.js';
import { candGroup, groupClass, isOff } from '../lib/cand-groups.js';
import { TIER_META, TIER_ORDER, ConfirmOverride, LimitConfirm, runConfirmed } from './step9-build.js';

const DAY_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const shortDate = (iso) => { const d = parseISODate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const longDate = (iso) => parseISODate(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
// name search ignores case and accents
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const WHAT = { road: 'route', backup: 'backup' };

// ---- the engine, with the build kept across a page reload ----------------------------
// The build lives in the engine's memory, which a reload empties. After every change
// the engine's state is saved with the draft (wizard.build.engine); a call that finds
// the engine empty puts it back from there and tries again. Undo history doesn't survive.
let restoring = null;
export function restoreEngine() {
  const st = getState().wizard.build.engine;
  if (!st) return Promise.resolve(false);
  if (!restoring) {
    restoring = editRequest('load_state', { state: st }).then((m) => {
      restoring = null;
      if (m.ok) setWizard((w) => ({ build: { ...w.build, report: m.report, xlsx: m.xlsx || w.build.xlsx } }));
      return m.ok;
    });
  }
  return restoring;
}
export async function buildReq(op, payload) {
  let m = await editRequest(op, payload);
  if (!m.ok && m.error && m.error.kind === 'no_state' && await restoreEngine()) m = await editRequest(op, payload);
  return m;
}
export async function saveEngine() {
  const ex = await editRequest('export_state', {});
  if (ex.ok) setWizard((w) => ({ build: { ...w.build, engine: ex.data.state } }));
}

// An edit that may need pop-ups the engine only reports when tried (set_role):
// show them, then try again with the OK.
export async function runAsking(op, payload, who, setUnav, setLimit, done) {
  const m = await buildReq(op, payload);
  if (m.ok) { done(m); return; }
  if (m.error.kind === 'needs_confirm') {
    setUnav({ ...who, reasons: [m.error.message.replace(/ Confirm the override first\.$/, '')],
      run: () => runAsking(op, { ...payload, confirm_unavailable: true }, who, setUnav, setLimit, done) });
  } else if (m.error.kind === 'needs_limits') {
    setLimit({ ...who, limits: m.error.limits || [],
      run: () => runAsking(op, { ...payload, confirm_limits: true }, who, setUnav, setLimit, done) });
  } else toast(m.error.message, 'err');
}

// Several people's pop-ups in a row (a trade checks both drivers), then run().
function runSteps(steps, setUnav, setLimit, run) {
  const next = (i) => {
    if (i >= steps.length) { run(); return; }
    const s = steps[i];
    if (s.unav) setUnav({ name: s.name, day: s.day, role: s.role, reasons: s.unav, run: () => next(i + 1) });
    else if ((s.limits || []).length) setLimit({ name: s.name, day: s.day, role: s.role, limits: s.limits, run: () => next(i + 1) });
    else next(i + 1);
  };
  next(0);
}

// ---- what's still open --------------------------------------------------------------
// Per open day: routes / backups needed and filled, each wave's fill, trainers, extras.
export function coverage(r) {
  const days = (r.days || []).filter((x) => x.open).map((x) => {
    const got = {};
    let trainers = 0;
    for (const d of r.drivers || []) {
      const c = cellInfo((d.cells || {})[x.day]);
      if (c.kind === 'road' || c.kind === 'trainee') got[c.top] = (got[c.top] || 0) + 1;
      if (c.kind === 'trainer') trainers += 1;
    }
    const waveList = [...new Set([...Object.keys(x.waves || {}), ...Object.keys(got)])]
      .sort((a, b) => waveMins(a) - waveMins(b))
      .map((w) => ({ wave: w, want: (x.waves || {})[w] || 0, got: got[w] || 0 }));
    return { ...x, waveList, fills: got, trainers,
      openR: Math.max(0, x.routes - x.routes_filled), openB: Math.max(0, x.backup - x.backup_filled),
      extraR: Math.max(0, x.routes_filled - x.routes), extraB: Math.max(0, x.backup_filled - x.backup) };
  });
  return { days, openR: days.reduce((t, x) => t + x.openR, 0), openB: days.reduce((t, x) => t + x.openB, 0) };
}

export function openSummary(r) {
  const cv = coverage(r);
  return cv.days.filter((x) => x.openR || x.openB).map((x) => `${x.day}: ${[
    x.openR ? plural(x.openR, 'route') : '', x.openB ? plural(x.openB, 'backup') : ''].filter(Boolean).join(' + ')} open`);
}

export function CoverageCard({ r, busy, onFind, onCounts }) {
  const cv = coverage(r);
  const all = !cv.openR && !cv.openB;
  return html`<div class="card cov-card">
    <h3>Routes and backups by day</h3>
    ${all ? html`<${Banner} kind="ok"><b>Everything is covered.</b> Every route and every backup has a driver.<//>`
      : html`<${Banner} kind=${cv.openR ? 'err' : 'warn'}><b>Still open:</b> ${[
          cv.openR ? plural(cv.openR, 'route') : '', cv.openB ? plural(cv.openB, 'backup') : ''].filter(Boolean).join(' and ')}.
          Use <b>Fill</b> on that day — it lists who can take it, safest first. A 6-day or overtime is allowed after a pop-up.<//>`}
    <div class="scroll-x"><table class="cov-table">
      <thead><tr><th>Day</th><th>Routes</th><th>Waves</th><th>Backups</th><th>Trainers</th><th></th></tr></thead>
      <tbody>${cv.days.map((x) => html`<tr class=${x.openR ? 'cov-bad' : x.openB ? 'cov-warn' : ''}>
        <td><b>${x.day}</b> <span class="muted">${shortDate(x.date)}</span></td>
        <td class="cov-num"><b class=${x.openR ? 'lv-bad' : ''}>${x.routes_filled}/${x.routes}</b>
          ${x.openR ? html`<div class="cov-tag bad">${x.openR} open</div>` : x.extraR ? html`<div class="cov-tag">+${x.extraR} extra</div>` : html`<div class="cov-tag ok">✓</div>`}</td>
        <td><div class="cov-waves">${x.waveList.map((w) => html`<span class=${'cov-wave' + (w.got < w.want ? ' short' : '')}
          style=${`background:${waveBg(w.wave)}`} title=${`${w.wave}: ${w.got} of ${w.want} routes filled`}>
          ${w.wave.replace(/ [AP]M$/, '')} <b>${w.got}/${w.want}</b></span>`)}</div></td>
        <td class="cov-num"><b class=${x.openB ? 'lv-warn' : ''}>${x.backup_filled}/${x.backup}</b>
          ${x.openB ? html`<div class="cov-tag warn">${x.openB} open</div>` : x.extraB ? html`<div class="cov-tag">+${x.extraB} extra</div>` : html`<div class="cov-tag ok">✓</div>`}</td>
        <td class="cov-num">${x.trainers || '—'}</td>
        <td><div class="cov-btns">
          ${x.openR ? html`<button class="small accent" disabled=${busy} onClick=${() => onFind({ day: x.day, role: 'road', mode: 'fill' })}>Fill ${plural(x.openR, 'route')}</button>` : ''}
          ${x.openB ? html`<button class="small primary" disabled=${busy} onClick=${() => onFind({ day: x.day, role: 'backup', mode: 'fill' })}>Fill ${plural(x.openB, 'backup')}</button>` : ''}
          <button class="small" disabled=${busy} title="Add one more backup than the day's count"
            onClick=${() => onFind({ day: x.day, role: 'backup', mode: 'extra' })}>+ Backup</button>
          <button class="small" disabled=${busy} title="Put one more driver on a route than the day's count"
            onClick=${() => onFind({ day: x.day, role: 'road', mode: 'extra' })}>+ Extra driver</button>
          <button class="small link" disabled=${busy} title="Change how many routes each wave has and how many backups"
            onClick=${() => onCounts(x.day)}>Counts…</button>
        </div></td>
      </tr>`)}</tbody>
    </table></div>
  </div>`;
}

// ---- who can take a shift -----------------------------------------------------------
const GROUPS = [
  ['ok', 'Safe — no rule breaks'],
  ['warn', 'Allowed, but flagged — a company policy (day targets, Fair caps, backup rules)'],
  ['confirm', 'Overtime — allowed after a pop-up'],
  ['confirm6', '6 days out of 7 — allowed after a pop-up'],
  ['blocked', 'Locked — 12h a day, 60h in 7 days, 7 days in a row, or a clash'],
];

function CandRow({ c, busy, onPick, extra }) {
  const meta = TIER_META[c.cls] || TIER_META.free;
  const blocked = c.status === 'blocked';
  const days = [
    (c.road_days || []).length ? 'Route ' + c.road_days.slice().sort((a, b) => DAY_IDX[a] - DAY_IDX[b]).join(' ') : '',
    (c.backup_days || []).length ? 'Bk ' + c.backup_days.slice().sort((a, b) => DAY_IDX[a] - DAY_IDX[b]).join(' ') : '',
  ].filter(Boolean).join(' · ') || 'no days yet';
  return html`<div class=${'cand ' + groupClass(candGroup(c))}>
    <button class="cand-pick" disabled=${busy || blocked} onClick=${() => !blocked && onPick(c)}>${blocked ? '🔒 ' : '+ '}${c.name}</button>
    ${isOff(c) ? html`<span class="chip off-chip" title=${(c.reasons || [])[0] || ''}>Unavailable</span>` : ''}
    <span class="chip ${meta.chip}">${meta.short}</span>
    <span class="cand-hours"><b>${plural((c.road_days || []).length + (c.backup_days || []).length, 'day')}</b> · ${c.hours}h → ${c.new_hours}h</span>
    <span class="muted">${days}</span>${extra || ''}
    ${(c.reasons || []).length ? html`<div class="cand-why">${c.reasons.join('; ')}</div>` : ''}
    ${(c.notes || []).length ? html`<div class="cand-note">${c.notes.join('; ')}</div>` : ''}
  </div>`;
}

function Grouped({ list, busy, onPick, q, row }) {
  const [showBlocked, setShowBlocked] = useState(false);
  const qf = fold(q.trim());
  const shown = qf ? list.filter((c) => fold(c.name).includes(qf)) : list;
  if (!shown.length) return html`<p class="muted">${qf ? `Nobody matches “${q.trim()}”.` : 'Nobody to list.'}</p>`;
  return GROUPS.map(([status, label]) => {
    const g = shown.filter((c) => candGroup(c) === status);
    if (!g.length) return '';
    if (status === 'blocked' && !showBlocked && !qf) {
      return html`<p class="muted"><button class="link" onClick=${() => setShowBlocked(true)}>Show the ${g.length} who can't (and why)</button></p>`;
    }
    return html`<div class="cand-group">
      <h4 class=${'cand-h ' + groupClass(status)}>${label} (${g.length})</h4>
      ${g.map((c) => (row ? row(c) : html`<${CandRow} c=${c} busy=${busy} onPick=${onPick} />`))}
    </div>`;
  });
}

// Fill an open route / backup on a day, or add one more than the day's count.
// find = {day, role, mode: 'fill' | 'extra'}
export function PickDriver({ find, info, onClose, onDone }) {
  const { day, role, mode } = find;
  const [st, setSt] = useState({ loading: true });
  const [q, setQ] = useState('');
  const [wave, setWave] = useState('');
  const [busy, setBusy] = useState(false);
  const [unav, setUnav] = useState(null);
  const [limit, setLimit] = useState(null);
  useEffect(() => {
    let alive = true;
    buildReq('candidates', { day, role }).then((m) => {
      if (alive) setSt(m.ok ? { list: m.data.candidates } : { error: m.error });
    });
    return () => { alive = false; };
  }, [day, role]);
  const waves = info ? info.waveList.map((w) => w.wave) : [];
  const open = info ? (role === 'road' ? info.openR : info.openB) : 0;
  // "fill" with nothing left open becomes an extra
  const extra = mode === 'extra' || !open;

  function pick(c) {
    runConfirmed({ name: c.name, day, role, unavReasons: c.status === 'unavail' ? c.reasons : null, limits: c.limits },
      setUnav, setLimit, async (flags) => {
        setBusy(true);
        const m = !extra && !wave ? await buildReq('apply', { day, role, to_name: c.name, ...flags })
          : await buildReq('apply_add', { name: c.name, day, role, ...(wave ? { wave } : role === 'road' ? { extra_route: true, keep_counts: true } : {}), ...flags });
        setBusy(false);
        if (!m.ok) { setSt((s) => ({ ...s, error: m.error })); return; }
        onDone(m);
      });
  }

  const title = extra
    ? (role === 'road' ? `Put an extra driver on a ${day} route` : `Add one more ${day} backup`)
    : open === 1 ? `Fill the open ${day} ${WHAT[role]}` : `Fill ${day}'s ${open} open ${WHAT[role]}s`;
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>${title}</h3>
      <p class="hint">${extra
        ? (role === 'road' ? `The day keeps its ${info ? info.routes : ''} routes on the count — this driver is one more (e.g. for a rescue or a ride-along you want). `
          : `Backups don't change the route count. `)
        : ''}Pick who takes it. Each name says what it does to their week.</p>
      <div class="row" style="margin:6px 0 10px">
        <input type="search" placeholder="Search a driver…" value=${q} onInput=${(e) => setQ(e.target.value)} style="min-width:220px" />
        ${waves.length ? html`<label class="row" style="gap:6px">Wave:
          <select value=${wave} onChange=${(e) => setWave(e.target.value)}>
            <option value="">${role === 'road' ? (extra ? 'any' : 'the one that is short') : 'fewest backups'}</option>
            ${waves.map((w) => html`<option value=${w}>${w}</option>`)}
          </select></label>` : ''}
      </div>
      ${st.error ? html`<${Banner} kind="err">${st.error.message}<//>` : ''}
      ${st.loading ? html`<p><${Spinner}/> Checking every driver against the rules…</p>` : ''}
      ${st.list ? html`<${Grouped} list=${st.list} busy=${busy} onPick=${pick} q=${q} />` : ''}
      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
        ${busy ? html`<span><${Spinner}/> Applying…</span>` : ''}
      </div>
    </div>
    ${unav ? html`<${ConfirmOverride} req=${unav} onCancel=${() => setUnav(null)} onConfirm=${() => { const x = unav; setUnav(null); x.run(); }} />` : ''}
    ${limit ? html`<${LimitConfirm} req=${limit} onCancel=${() => setLimit(null)} onConfirm=${() => { const x = limit; setLimit(null); x.run(); }} />` : ''}
  </div>`;
}

// ---- trade two drivers' shifts ------------------------------------------------------
export function TradeModal({ name, day, onClose, onDone }) {
  const [st, setSt] = useState({ loading: true });
  const [q, setQ] = useState('');
  const [dayF, setDayF] = useState('');
  const [busy, setBusy] = useState(false);
  const [unav, setUnav] = useState(null);
  const [limit, setLimit] = useState(null);
  const first = name.split(/\s+/)[0];
  useEffect(() => {
    let alive = true;
    buildReq('trade_options', { name, day }).then((m) => { if (alive) setSt(m.ok ? { data: m.data } : { error: m.error }); });
    return () => { alive = false; };
  }, [name, day]);
  const data = st.data;
  const opts = data ? data.options.filter((o) => !dayF || o.day === dayF) : [];
  const days = data ? [...new Set(data.options.map((o) => o.day))].sort((a, b) => DAY_IDX[a] - DAY_IDX[b]) : [];
  const usable = (d) => data.options.filter((o) => o.day === d && o.status !== 'blocked').length;
  const shiftTxt = (d, role, label) => `${d} ${WHAT[role]}${cellInfo(label).top && cellInfo(label).top !== 'Backup' ? ' ' + cellInfo(label).top : ''}`;

  function pick(o) {
    const steps = [];
    for (const [who, side, d, role] of [[name, o.mine, o.day, o.role], [o.name, o.theirs, day, data.role]]) {
      if (side.status === 'unavail') steps.push({ name: who, day: d, role, unav: side.reasons });
      if ((side.limits || []).length) steps.push({ name: who, day: d, role, limits: side.limits });
    }
    runSteps(steps, setUnav, setLimit, async () => {
      setBusy(true);
      const m = await buildReq('apply_trade', { name, day, with_name: o.name, with_day: o.day,
        confirm_unavailable: steps.some((s) => s.unav), confirm_limits: steps.some((s) => s.limits) });
      setBusy(false);
      if (!m.ok) { setSt((s) => ({ ...s, error: m.error })); return; }
      onDone(m);
    });
  }
  const row = (o) => {
    const meta = TIER_META[o.cls] || TIER_META.free;
    const blocked = o.status === 'blocked';
    const side = (who, s) => (s.reasons || []).length ? html`<div class=${'cand-why' + (s.status === 'blocked' ? ' locked' : '')}><b>${who}:</b> ${s.reasons.join('; ')}</div>` : '';
    return html`<div class=${'cand ' + o.status}>
      <button class="cand-pick" disabled=${busy || blocked} onClick=${() => !blocked && pick(o)}>${blocked ? '🔒 ' : '⇄ '}${o.name}</button>
      <span class="chip ${meta.chip}">${meta.short}</span>
      <span class="cand-hours">gives <b>${shiftTxt(o.day, o.role, o.label)}</b></span>
      <span class="muted">${o.name.split(/\s+/)[0]} ${o.hours}h → ${o.new_hours}h · ${first} ${o.my_hours}h → ${o.my_new_hours}h</span>
      ${side(first, o.mine)}${side(o.name.split(/\s+/)[0], o.theirs)}
    </div>`;
  };
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>Trade ${first}'s ${data ? shiftTxt(day, data.role, data.label) : day + ' shift'}</h3>
      <p class="hint">${first} gives this shift away and takes the other driver's shift in return — two people swap.
        Same day: a route and a backup change hands. Both sides are checked against the rules.</p>
      ${data ? html`<div class="row cov-days" style="margin:6px 0">
        <button class=${'small' + (!dayF ? ' primary' : '')} onClick=${() => setDayF('')}>All days</button>
        ${days.map((d) => html`<button class=${'small' + (dayF === d ? ' primary' : '')} onClick=${() => setDayF(d)}>${d} <span class="muted">${usable(d)}</span></button>`)}
      </div>` : ''}
      <div class="row" style="margin:6px 0 10px">
        <input type="search" placeholder="Search a driver…" value=${q} onInput=${(e) => setQ(e.target.value)} style="min-width:220px" />
      </div>
      ${st.error ? html`<${Banner} kind="err">${st.error.message}<//>` : ''}
      ${st.loading ? html`<p><${Spinner}/> Checking every possible trade…</p>` : ''}
      ${data ? html`<${Grouped} list=${opts} busy=${busy} q=${q} row=${row} />` : ''}
      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
        ${busy ? html`<span><${Spinner}/> Applying…</span>` : ''}
      </div>
    </div>
    ${unav ? html`<${ConfirmOverride} req=${unav} onCancel=${() => setUnav(null)} onConfirm=${() => { const x = unav; setUnav(null); x.run(); }} />` : ''}
    ${limit ? html`<${LimitConfirm} req=${limit} onCancel=${() => setLimit(null)} onConfirm=${() => { const x = limit; setLimit(null); x.run(); }} />` : ''}
  </div>`;
}

// ---- one driver, one day: every choice ----------------------------------------------
function Block({ v, why }) {
  const c = cellInfo(v);
  if (c.kind === 'empty') return '';
  return html`<div class=${'lv-blk b-' + c.kind} style=${c.bg ? `background:${c.bg}` : ''} title=${why || undefined}>
    <span>${c.top}</span>${c.sub ? html`<small>${c.sub}</small>` : ''}</div>`;
}

const Act = ({ icon, title, sub, onClick, busy, tone }) => html`<button class=${'dm-act' + (tone ? ' ' + tone : '')}
  disabled=${busy} onClick=${onClick}><span class="dm-ico">${icon}</span>
  <span><b>${title}</b>${sub ? html`<small>${sub}</small>` : ''}</span></button>`;

function RuleNote({ st, first }) {
  if (!st) return '';
  if (st.status === 'blocked') return html`<div class="lv-lock">🔒 ${st.reasons.join('; ')}</div>`;
  const warns = (st.status === 'warn' || st.status === 'full' || st.status === 'confirm' || st.status === 'unavail')
    ? st.reasons.filter((x) => !/^(6-day|overtime|at the \d+ road-day cap)/.test(x)) : [];
  const off = st.status === 'unavail' ? warns.shift() : null;
  return html`
    ${off ? html`<div class="lv-note unavail">${first} ${off} — you'll confirm first.</div>` : ''}
    ${(st.limits || []).length ? html`<div class="lv-note confirm">${st.limits.join('; ')} — a pop-up will ask you first.</div>` : ''}
    ${warns.length ? html`<div class="lv-note warn">Allowed, but flagged: ${warns.join('; ')}</div>` : ''}`;
}

// cell = {name, day}; act(what, payload) runs it in Step 9
export function DayMenu({ d, info, r, busy, onClose, act }) {
  const day = info.day;
  const v = (d.cells || {})[day] || '';
  const c = cellInfo(v);
  const role = c.kind === 'road' ? 'road' : c.kind === 'bk' ? 'backup' : null;
  const first = d.name.split(/\s+/)[0];
  const free = c.kind === 'empty' || c.kind === 'off';
  const [opt, setOpt] = useState(null);
  useEffect(() => {
    if (!free) return undefined;
    let alive = true;
    buildReq('add_options', { name: d.name }).then((m) => {
      if (alive) setOpt(m.ok ? (m.data.days.find((x) => x.day === day) || {}) : { error: m.error });
    });
    return () => { alive = false; };
  }, [d.name, day, free]);
  const lim = r.limits || {};
  const nDays = (d.worked_dates || []).filter((x) => x >= ((r.days || [])[0] || {}).date).length;
  const why = (d.unav_why || {})[day];

  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card daymodal" role="dialog" aria-label=${`${d.name}, ${longDate(info.date)}`}>
      <div class="dm-head">
        <div class="dm-who"><div class="dm-name">${d.name}</div><div class="dm-date">${longDate(info.date)}</div></div>
        <div class="dm-now">${c.kind === 'empty' ? html`<span class="muted">Not scheduled</span>` : html`<${Block} v=${v} />`}</div>
        <button class="dm-x" aria-label="Close" onClick=${onClose}>×</button>
      </div>
      <div class="dm-stats">
        <div><b>${d.hours}h</b><span>this week</span></div>
        <div class=${nDays >= (lim.max_worked_days || 5) ? 'hot' : ''}><b>${nDays}</b><span>days this week (usual max ${lim.max_worked_days || 5})</span></div>
        <div class=${d.streak >= (lim.max_consecutive || 5) ? 'hot' : ''}><b>${d.streak}</b><span>days in a row, last week counts</span></div>
        <div class=${(d.max7 ?? 0) > (lim.max_7day_hours || 60) - 6 ? 'hot' : ''}><b>${d.max7 ?? '—'}h</b><span>most in any 7 days (max ${lim.max_7day_hours || 60})</span></div>
      </div>
      ${c.kind === 'off' ? html`<div class="dm-info warn"><b>${first} is off ${day}</b>${why ? ` — ${why === 'Not hired yet' ? 'not hired yet' : 'from the Drivers page'}` : ' — marked Unavailable'}.
        You can still give them a shift after confirming you talked to them.</div>` : ''}
      ${c.kind === 'trainer' || c.kind === 'trainee' ? html`<div class="dm-info">${c.kind === 'trainer'
        ? html`<b>Trainer</b> — rides along with <b>${c.partner}</b> on the ${c.top} route.`
        : html`<b>Trainee</b> — drives the ${c.top} route with trainer <b>${c.partner}</b>.`}
        Training pairs are set on <b>Trainers & settings</b> — change them there and rebuild.</div>` : ''}

      ${role ? html`
        <div class="dm-sec">Change this ${WHAT[role]}</div>
        <div class="dm-grid">
          <${Act} icon="→" title="Give it to someone else" sub="The table lights up who can take it" busy=${busy}
            onClick=${() => act('move', { day, role, fromName: d.name })} />
          <${Act} icon="⇄" title="Trade with someone" sub=${`${first} takes their shift, they take this one`} busy=${busy}
            onClick=${() => act('trade', { name: d.name, day })} />
          <${Act} icon="🕑" title="Change wave" sub="Another start time" busy=${busy}
            onClick=${() => act('wave', { day, name: d.name })} />
          ${role === 'road'
            ? html`<${Act} icon="↓" title="Make it a backup" sub="Same wave — the route opens up" busy=${busy}
                onClick=${() => act('role', { name: d.name, day, to: 'backup' })} />`
            : html`<${Act} icon="↑" title="Make it a route" sub="Checked like any new route" busy=${busy}
                onClick=${() => act('role', { name: d.name, day, to: 'road' })} />`}
          <${Act} icon="−" title="Take it off" sub=${`Leave the ${WHAT[role]} open`} tone="dm-danger" busy=${busy}
            onClick=${() => act('remove', { day, role, fromName: d.name })} />
        </div>` : ''}

      ${c.kind === 'disp' || c.kind === 'meet' ? html`<div class="dm-grid one">
        <${Act} icon="−" title=${c.kind === 'disp' ? 'Take off dispatch' : 'Take out of the meeting'} sub="The day becomes free"
          tone="dm-danger" busy=${busy} onClick=${() => act('unduty', { name: d.name, day })} /></div>` : ''}

      ${free ? html`
        <div class="dm-sec">Put ${first} on a route</div>
        ${!opt ? html`<p class="muted lv-dayshifts"><${Spinner}/> Checking the rules…</p>`
          : opt.error ? html`<${Banner} kind="err">${opt.error.message}<//>`
          : opt.road && opt.road.status === 'blocked' ? html`<${RuleNote} st=${opt.road} first=${first} />`
          : html`<div class="lv-dayshifts"><${RuleNote} st=${opt.road} first=${first} />
            <div class="lv-wavebtns">${info.waveList.map((w) => {
              const state = !w.want ? 'new wave · +1 extra' : w.got >= w.want ? 'full · +1 extra' : `${w.got} of ${w.want} filled`;
              return html`<button class="lv-wavebtn" disabled=${busy} style=${`background:${waveBg(w.wave)}`} title=${state}
                onClick=${() => act('add', { name: d.name, day, role: 'road', wave: w.wave, st: opt.road })}>
                <b>${w.wave}</b><small>${state}</small></button>`;
            })}</div></div>`}
        <div class="dm-sec">Or a backup</div>
        ${!opt || opt.error ? '' : opt.backup.status === 'blocked' ? html`<${RuleNote} st=${opt.backup} first=${first} />`
          : html`<div class="lv-dayshifts"><${RuleNote} st=${opt.backup} first=${first} />
            <div class="row"><button class=${'slot-btn ' + opt.backup.status} disabled=${busy}
              onClick=${() => act('add', { name: d.name, day, role: 'backup', st: opt.backup })}>
              + Backup ${day} <span class="muted">(${info.backup_filled}/${info.backup} filled${info.backup_filled >= info.backup ? ' — this one is extra' : ''})</span></button></div></div>`}` : ''}
      ${busy ? html`<p class="muted" style="margin-top:10px"><${Spinner}/> Applying…</p>` : ''}
    </div>
  </div>`;
}

// ---- the week grid ------------------------------------------------------------------
const SORTS = [['tier', 'Group'], ['name', 'A–Z'], ['hours', 'Hours'], ['days', 'Days']];

// moving = {day, role, fromName} while "give it to someone else" is picking; cands = its candidates
export function WeekGrid({ r, cov, busy, moving, cands, onCell, onName, onTake, onCounts }) {
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState('tier');
  const [only, setOnly] = useState('');            // '' | 'six' (6+ days) | 'free' (room for a shift)
  const lim = r.limits || {};
  const days = r.days || [];
  const start = (days[0] || {}).date || '';
  const nDays = (d) => (d.worked_dates || []).filter((x) => x >= start).length;
  const qf = fold(q.trim());
  let rows = (r.drivers || []).filter((d) => !qf || fold(d.name).includes(qf));
  if (only === 'six') rows = rows.filter((d) => nDays(d) >= (lim.max_worked_days || 5) + 1 || d.streak > (lim.max_consecutive || 5));
  if (only === 'short') rows = rows.filter((d) => nDays(d) < 4);
  const cmp = { name: (a, b) => a.name.localeCompare(b.name), hours: (a, b) => b.hours - a.hours || a.name.localeCompare(b.name),
    days: (a, b) => nDays(b) - nDays(a) || a.name.localeCompare(b.name) };
  const groups = sortBy === 'tier'
    ? TIER_ORDER.map((t) => ({ meta: TIER_META[t], rows: rows.filter((d) => d.cls === t) })).filter((g) => g.rows.length)
    : [{ meta: null, rows: rows.slice().sort(cmp[sortBy]) }];
  const candMap = moving && cands && cands.list ? new Map(cands.list.map((c) => [c.name, c])) : null;
  const covBy = Object.fromEntries((cov.days || []).map((x) => [x.day, x]));
  const nCols = days.length + 4;

  return html`<div>
    <div class="row lv-tools" style="margin:6px 0 8px; flex-wrap:wrap">
      <input type="search" placeholder="Search a driver…" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search a driver" />
      ${qf ? html`<span class="muted">${plural(rows.length, 'match')}</span>` : ''}
      <span class="muted">Sort:</span>
      ${SORTS.map(([k, label]) => html`<button class=${'small' + (sortBy === k ? ' primary' : '')} onClick=${() => setSortBy(k)}>${label}</button>`)}
      <span class="muted">Show:</span>
      <button class=${'small' + (!only ? ' primary' : '')} onClick=${() => setOnly('')}>Everyone</button>
      <button class=${'small' + (only === 'short' ? ' primary' : '')} title="Drivers with fewer than 4 days — room for another shift" onClick=${() => setOnly('short')}>Under 4 days</button>
      <button class=${'small' + (only === 'six' ? ' primary' : '')} title="Drivers on a 6-day or 6+ in a row" onClick=${() => setOnly('six')}>6-days</button>
    </div>
    <div class="scroll-x lv-wrap lv-tall"><table class="lv-grid be-grid">
      <thead><tr>
        <th class="lv-namecol">Driver</th>
        ${days.map((x) => {
          const cv = covBy[x.day];
          return html`<th class=${(x.open ? '' : 'closed') + (moving && moving.day === x.day ? ' be-movecol' : '')}>
            ${x.day} <span class="lv-date">${shortDate(x.date)}</span>
            ${x.open && cv ? html`<button class="lv-fill lv-fillbtn" disabled=${busy} onClick=${() => onCounts(x.day)}
              title="Routes and backups filled / needed — click to change the counts">
              <span class=${cv.openR ? 'lv-bad' : ''}>${x.routes_filled}/${x.routes}</span>
              <span class=${cv.openB ? 'lv-warnc' : ''}> · bk ${x.backup_filled}/${x.backup}</span></button>`
              : html`<div class="lv-fill">${x.open ? '' : 'closed'}</div>`}</th>`;
        })}
        <th class="lv-stat" title="Days worked this week">Days</th>
        <th class="lv-stat" title="Hours this week: route 10h, backup 2h">Hours</th>
        <th class="lv-stat" title=${`Longest run of days in a row, last week included (usual max ${lim.max_consecutive || 5})`}>In a row</th>
        <th class="lv-stat" title=${`Most hours on the clock in any 7 days, last week included (max ${lim.max_7day_hours || 60}h)`}>Max 7d</th>
      </tr></thead>
      <tbody>${!rows.length ? html`<tr><td colspan=${nCols} class="muted" style="text-align:left">No driver matches.</td></tr>` : ''}
        ${groups.map((g) => html`
          ${g.meta ? html`<tr class="tier-sep"><td colspan=${nCols}><span class="chip ${g.meta.chip}">${g.meta.label}</span>
            <span class="muted"> · ${g.rows.length}</span></td></tr>` : ''}
          ${g.rows.map((d) => {
            const tm = TIER_META[d.cls] || TIER_META.free;
            const c = candMap ? candMap.get(d.name) : null;
            const isSrc = moving && moving.fromName === d.name;
            const nd = nDays(d);
            return html`<tr class=${c ? 'cand-row ' + c.status : isSrc ? 'cand-row src' : ''}>
              <td class="lv-namecol">
                <button class="link lv-name" disabled=${!!moving} title=${'Give ' + d.name + ' a shift'} onClick=${() => onName(d.name)}>${d.name}</button>
                <span class="chip ${tm.chip} tier-mini" title=${tm.label}>${tm.short}${d.target != null ? ':' + d.target : ''}</span>
                ${(d.helper_days || []).length ? html` <span class="chip trainer-chip" title="Trains a new hire this week">Trainer</span>` : ''}
              </td>
              ${days.map((x) => {
                const v = (d.cells || {})[x.day] || '';
                const k = cellInfo(v).kind;
                const why = (d.unav_why || {})[x.day];
                // move mode: this day's column offers each driver the shift
                if (moving && x.day === moving.day && !isSrc && c) {
                  const ok = c.status !== 'blocked';
                  return html`<td class=${'lv-cell be-take ' + c.status}>
                    ${ok ? html`<button class=${'be-takebtn ' + c.status} disabled=${busy}
                        title=${(c.reasons || []).join('; ') || 'No rule breaks'}
                        onClick=${() => onTake(d.name)}>+ Take it<small>${c.hours}h → ${c.new_hours}h</small></button>`
                      : html`<span class="be-lock" title=${(c.reasons || []).join('; ')}>🔒 ${(c.reasons || [])[0] || ''}</span>`}
                    ${k !== 'empty' ? html`<div class="be-under"><${Block} v=${v} /></div>` : ''}</td>`;
                }
                return html`<td class=${'lv-cell k-' + k + (x.open ? '' : ' closed') + (isSrc && moving.day === x.day ? ' be-src' : '')}
                  title=${v ? (k === 'off' && why ? `${v} — ${why}` : v) : x.open ? 'Not scheduled — click for options' : 'Closed'}
                  onClick=${x.open && !moving ? () => onCell(d.name, x.day) : undefined}><${Block} v=${v} /></td>`;
              })}
              <td class=${'lv-stat' + (nd > (lim.max_worked_days || 5) ? ' lv-warn' : '')}>${nd}</td>
              <td class=${'lv-stat' + (d.hours > (lim.weekly_hours_cap || 40) ? ' lv-warn' : '')}>${d.hours}h</td>
              <td class=${'lv-stat' + (d.streak > (lim.max_consecutive || 5) ? ' lv-warn' : '')}>${d.streak}</td>
              <td class=${'lv-stat' + ((d.max7 ?? 0) > (lim.max_7day_hours || 60) ? ' lv-bad' : (d.max7 ?? 0) > (lim.max_7day_hours || 60) - 6 ? ' lv-warn' : '')}>${d.max7 ?? '—'}${d.max7 != null ? 'h' : ''}</td>
            </tr>`;
          })}`)}</tbody>
    </table></div>
    <div class="lv-legend">
      ${Object.entries(WAVE_COLORS).map(([w, bg]) => html`<span class="lv-sw" style=${`background:${bg}`}>${w}</span>`)}
      <span class="lv-sw" style=${`background:${SHIFT_COLORS.trainer}`}>Trainer</span>
      <span class="lv-sw" style=${`background:${SHIFT_COLORS.off}`}>Unavailable</span>
      <span class="muted">Click any day to change it · click a name to give that driver a shift</span>
    </div>
  </div>`;
}

// ---- someone who isn't on this week -------------------------------------------------
export function AddDriverCard({ r, busy, onDone }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(null);
  const [name, setName] = useState('');
  const [hire, setHire] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open || list) return;
    import('../lib/driver-prefs.js').then((m) => m.loadDriverRoster({ active: true })).then((all) => {
      const on = new Set((r.drivers || []).map((d) => fold(d.name)));
      setList((all || []).filter((x) => x.active !== false && !on.has(fold(x.name))).map((x) => x.name));
    }).catch(() => setList([]));
  }, [open]);
  async function add() {
    setSaving(true); setErr('');
    const m = await buildReq('add_driver', { name: name.trim(), ...(hire ? { hire_date: hire } : {}) });
    setSaving(false);
    if (!m.ok) { setErr(m.error.message); return; }
    const n = name.trim();
    setName(''); setHire(''); setList(null); setOpen(false);
    onDone(m, n);
  }
  if (!open) return html`<button class="small" disabled=${busy} onClick=${() => setOpen(true)}>+ Add a driver who isn't on this week</button>`;
  return html`<div class="be-adddrv">
    <b>Add a driver who isn't on this week</b>
    <p class="hint" style="margin:4px 0 8px">For someone missing from the availability file (a new hire, someone back).
      They join with no shifts — then give them days like anyone else.</p>
    <div class="row" style="flex-wrap:wrap">
      <input type="text" list="be-active" placeholder=${list ? 'Pick or type a name' : 'Loading the active drivers…'} value=${name}
        onInput=${(e) => setName(e.target.value)} style="min-width:240px" />
      <datalist id="be-active">${(list || []).map((n) => html`<option value=${n} />`)}</datalist>
      <label class="row" style="gap:6px">First day (if hired this week):
        <input type="date" value=${hire} onInput=${(e) => setHire(e.target.value)} /></label>
      <button class="primary small" disabled=${saving || !name.trim()} onClick=${add}>${saving ? html`<${Spinner}/> Adding…` : 'Add to the week'}</button>
      <button class="small" disabled=${saving} onClick=${() => setOpen(false)}>Cancel</button>
    </div>
    ${list && list.length ? html`<p class="muted" style="margin:6px 0 0">${plural(list.length, 'active driver')} not on this week.</p>` : ''}
    ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
  </div>`;
}

export { CountsEditor };

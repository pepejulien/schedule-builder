import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { useStore, setWizard, setState, getState, toast } from '../store.js';
import { StepNav, Embedded, goStep } from '../app.js';
import { Step8Review } from './step8-review.js';
import { ensureStanding } from './step7-standing.js';
import { Banner, Spinner, download } from '../ui.js';
import { assembleFromWizard } from '../build-inputs.js';
import { build, editRequest } from '../solver-client.js';
import { storeGet, storePutJSON } from '../api.js';
import { driverCsv } from '../lib/driver-csv.js';
import { GROUP_OPTIONS } from '../lib/config-assemble.js';
import { AdvancedPanel } from './advanced-panel.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function translateInfeasible(line) {
  let m = line.match(/P1 INFEASIBLE (\w+): filled (\d+)\/(\d+)/);
  if (m) return `${m[1]}: only ${m[2]} of ${m[3]} routes could be filled — not enough available drivers.`;
  m = line.match(/P2 SHORT (\w+): (\d+)\/(\d+)/);
  if (m) return `${m[1]}: only ${m[2]} of ${m[3]} backups could be assigned.`;
  return line;
}

// Verifier lines for rules a manual override knowingly broke -> plain words.
function translateOverride(line) {
  let m = line.match(/^UNAVAIL violated: (.+) (\w{3})$/);
  if (m) return `${m[1]} works ${m[2]} — they marked that day Unavailable.`;
  m = line.match(/^TARGET (.+): want (\d+) got (\d+)/);
  if (m) return `${m[1]} has ${m[3]} road days (set to ${m[2]}).`;
  m = line.match(/^FAIR-SHAPE: (.+) roads\+backups over (\d+)/);
  if (m) return `${m[1]} is over the Fair ${m[2]}-day limit.`;
  m = line.match(/^BACKUP<2PRIMARY: (.+)$/);
  if (m) return `${m[1]} has a backup with fewer than 2 road days.`;
  m = line.match(/^BACKUP-ONLY: (.+)$/);
  if (m) return `${m[1]} has backup days but no road days.`;
  return line;
}

// Remember who trained whom this week, so Auto training pairs rotate.
// Keyed by week start; a rebuild of the same week overwrites its entry.
async function saveTrainingHistory(weekISO, pairlog) {
  if (!weekISO) return null;
  let h = {};
  try { const cur = await storeGet('standing/training-history.json'); if (cur && typeof cur === 'object') h = cur; } catch { /* start fresh */ }
  h[weekISO] = (pairlog || []).map((p) => [p[0], p[1], p[2]]);
  const keep = Object.keys(h).sort().slice(-26);           // ~6 months is plenty
  const out = {};
  for (const k of keep) out[k] = h[k];
  try { await storePutJSON('standing/training-history.json', out); } catch { /* offline: rotation just won't advance */ }
  return out;
}

// A deliberate speed bump before scheduling someone on a day they submitted
// off: tick the box AND type their first name. Compliance rules never get
// here — those can't be overridden at all.
function ConfirmOverride({ req, onCancel, onConfirm }) {
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const first = req.name.trim().split(/\s+/)[0];
  const okName = typed.trim().toLowerCase() === first.toLowerCase();
  const what = req.role === 'road' ? 'a route' : 'a backup';
  const why = req.reasons[0] || 'marked Unavailable that day';
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
    <div class="edit-modal card override-modal">
      <h3>⚠ ${req.name} is OFF on ${req.day}</h3>
      <p><b>${why[0].toUpperCase() + why.slice(1)}.</b> You're about to give them ${what} anyway.</p>
      ${req.reasons.length > 1 ? html`<p class="muted">Also: ${req.reasons.slice(1).join('; ')}</p>` : ''}
      <p class="hint">Only do this if you've talked to ${first} and they agreed to work ${req.day}.
        It will be logged as an override on this schedule.</p>
      <label class="row" style="gap:8px; margin:10px 0">
        <input type="checkbox" checked=${ack} onChange=${(e) => setAck(e.target.checked)} />
        I confirmed with ${first} that they will work ${req.day}.
      </label>
      <label>Type <b>${first}</b> to confirm:
        <input type="text" value=${typed} autocomplete="off"
          onInput=${(e) => setTyped(e.target.value)} style="margin-left:8px; width:160px" /></label>
      <div class="row" style="margin-top:14px">
        <button onClick=${onCancel}>Cancel</button>
        <button class="danger" disabled=${!(ack && okName)} onClick=${onConfirm}>
          Schedule ${first} on ${req.day} anyway</button>
      </div>
    </div>
  </div>`;
}

async function bytesToText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return new TextDecoder('utf-8').decode(new Uint8Array(v));
}

// Group the per-driver rows by day-target tier, highest tier at the top.
// Chip colors match the tiers. (Module-level so the slot editor shares it.)
const TIER_META = {
  most: { label: 'Top / Solid', chip: 'green', short: 'top/solid' },
  free: { label: 'Fair', chip: 'lav', short: 'fair' },
  reduced: { label: 'Underperforming / Termination', chip: 'gray', short: 'reduced' },
  exact: { label: 'Exact / pinned', chip: 'blue', short: 'exact' },
};
const TIER_ORDER = ['most', 'free', 'reduced', 'exact'];

// Compact-list view for moving/filling one (day, role) slot. Purely
// presentational — the candidate fetch and the apply live in Step9Build so
// this modal and the in-table move mode share the same data.
function SlotEditor({ editor, cands, busy, onPick, onClose, onTableView }) {
  const { day, role, fromName } = editor;
  const what = role === 'road' ? 'route' : 'backup';
  const st = cands || { loading: true, error: null, list: null };

  const GROUPS = [
    ['ok', 'Safe — no rule would break'],
    ['warn', 'Allowed, but will be flagged'],
    ['unavail', 'Day off — needs a confirmed override'],
    ['blocked', 'Locked — compliance rule'],
  ];
  const byStatus = {};
  for (const c of (st.list || [])) (byStatus[c.status] = byStatus[c.status] || []).push(c);

  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>${fromName
        ? `Move the ${day} ${what} — currently ${fromName}`
        : `Assign the open ${day} ${what}`}</h3>
      <p class="hint">Pick who takes it. Green is safe. Yellow breaks a company policy (day targets, Fair caps)
        — allowed, but logged. Red asked for the day off — you'll have to confirm. Grey is a compliance
        rule (5-day streaks, overtime, worked-day caps) and can't be overridden.</p>

      ${st.error ? html`<${Banner} kind="err">
        ${st.error.message}
        ${st.error.kind === 'no_state' ? html`<div class="hint">Manual edits work on the build from this
          session. Hit “Rebuild with changes” once, then edit.</div>` : ''}
      <//>` : ''}
      ${st.loading ? html`<p><${Spinner}/> Checking every driver against the rules…</p>` : ''}

      ${GROUPS.map(([status, label]) => {
        const list = byStatus[status];
        if (!list || !list.length) return '';
        return html`<div class="cand-group">
          <h4 class=${'cand-h ' + status}>${label} (${list.length})</h4>
          ${list.map((c) => {
            const meta = TIER_META[c.cls] || TIER_META.free;
            const nDays = c.road_days.length + c.backup_days.length;
            const days = [
              c.road_days.length ? 'Road: ' + c.road_days.join(' ') : '',
              c.backup_days.length ? 'Bk: ' + c.backup_days.join(' ') : '',
            ].filter(Boolean).join(' · ') || 'no days yet';
            const clickable = status !== 'blocked';
            return html`<div class=${'cand ' + status}>
              <button class="cand-pick" disabled=${busy || !clickable}
                onClick=${() => clickable && onPick(c.name)}>${status === 'blocked' ? '🔒 ' : ''}${c.name}</button>
              <span class="chip ${meta.chip}">${meta.short}</span>
              <span class="cand-hours"><b>${nDays} day${nDays === 1 ? '' : 's'}</b> · ${c.hours}h → ${c.new_hours}h</span>
              <span class="muted">${days}</span>
              ${(c.reasons || []).length ? html`<div class="cand-why">${c.reasons.join('; ')}</div>` : ''}
              ${(c.notes || []).length ? html`<div class="cand-note">${c.notes.join('; ')}</div>` : ''}
            </div>`;
          })}
        </div>`;
      })}

      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onTableView}>Pick from the table instead</button>
        ${fromName && role === 'backup' ? html`<button disabled=${busy}
          onClick=${() => onPick(null)}>Remove — leave this backup slot unfilled</button>` : ''}
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
        ${busy ? html`<span><${Spinner}/> Applying…</span>` : ''}
      </div>
    </div>
  </div>`;
}

// Modal for giving one driver an EXTRA shift. Shows every operating day with
// what they're doing now and whether a route / backup can be added. A route
// on a full day opens the swap step: pick who steps down to backup (freeing
// their slot), or add it as a genuine extra route.
function AddEditor({ name, onClose, onApplied }) {
  const [opts, setOpts] = useState({ loading: true, error: null, data: null });
  const [swap, setSwap] = useState(null);   // {day, want, confirmed, loading, error, list} | null
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // ConfirmOverride request | null

  useEffect(() => {
    let alive = true;
    setOpts({ loading: true, error: null, data: null });
    setSwap(null);
    editRequest('add_options', { name }).then((m) => {
      if (!alive) return;
      setOpts(m.ok ? { loading: false, error: null, data: m.data }
        : { loading: false, error: m.error, data: null });
    });
    return () => { alive = false; };
  }, [name]);

  async function openSwap(day, want, confirmed = false) {
    setSwap({ day, want, confirmed, loading: true, error: null, list: null });
    const m = await editRequest('swap_candidates', { day, for_name: name });
    setSwap((s) => (s && s.day === day)
      ? (m.ok ? { day, want, confirmed, loading: false, error: null, list: m.data.candidates }
        : { day, want, confirmed, loading: false, error: m.error, list: null })
      : s);
  }

  // A day the driver asked off: confirm first, then add (or open the swap
  // step if that day's routes are full).
  function overrideDay(dd, role) {
    const cell = role === 'road' ? dd.road : dd.backup;
    setConfirm({ name, day: dd.day, role, reasons: cell.reasons,
      run: () => (role === 'road' && dd.road.full
        ? openSwap(dd.day, dd.road.want, true)
        : apply({ day: dd.day, role, confirm_unavailable: true })) });
  }
  const lockWhy = (cell) => html`<span class="cand-inline-why" title=${cell.reasons.join('; ')}>🔒 ${cell.reasons[0] || ''}</span>`;

  async function apply(payload) {
    setBusy(true);
    const m = await editRequest('apply_add', { name, ...payload });
    setBusy(false);
    if (!m.ok) { setOpts((o) => ({ ...o, error: m.error })); return; }
    onApplied(m);
  }

  const CUR = { route: 'Route', backup: 'Backup', helper: 'Training',
    meeting: 'Meeting', dispatch: 'Dispatch', unavailable: 'Unavailable' };
  const data = opts.data;

  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>Add an extra shift — ${name}${data ? html` <span class="muted">(${data.hours}h now)</span>` : ''}</h3>
      <p class="hint">Pick a day. A route adds ${data ? data.ph : 10}h, a backup adds ${data ? data.bh : 2}h.
        Yellow is allowed but flagged. Red is a day they asked off — you'll have to confirm.
        🔒 is a compliance rule and can't be overridden.</p>

      ${opts.error ? html`<${Banner} kind="err">
        ${opts.error.message}
        ${opts.error.kind === 'no_state' ? html`<div class="hint">Manual edits work on the build from this
          session. Hit “Rebuild with changes” once, then edit.</div>` : ''}
      <//>` : ''}
      ${opts.loading ? html`<p><${Spinner}/> Checking every day against the rules…</p>` : ''}

      ${data && !swap ? html`<div class="scroll-x"><table class="addgrid">
        <thead><tr><th>Day</th><th>Now</th><th>Route (+${data.ph}h)</th><th>Backup (+${data.bh}h)</th></tr></thead>
        <tbody>${data.days.map((dd) => {
          const roadCell = dd.road.status === 'blocked'
            ? lockWhy(dd.road)
            : dd.road.status === 'unavail'
            ? html`<button class="slot-btn unavail" disabled=${busy} title=${dd.road.reasons.join('; ')}
                onClick=${() => overrideDay(dd, 'road')}>Day off — override…</button>`
            : dd.road.status === 'full'
            ? html`<button class="slot-btn full" disabled=${busy}
                title=${`All ${dd.road.want} route(s) on ${dd.day} are filled — someone must step down to backup`}
                onClick=${() => openSwap(dd.day, dd.road.want)}>Full — swap someone…</button>`
            : html`<button class=${'slot-btn ' + dd.road.status} disabled=${busy}
                title=${dd.road.reasons.join('; ')}
                onClick=${() => apply({ day: dd.day, role: 'road' })}>
                + Route${dd.road.status === 'warn' ? ' (flagged)' : ''}</button>`;
          const bkCell = dd.backup.status === 'blocked'
            ? lockWhy(dd.backup)
            : dd.backup.status === 'unavail'
            ? html`<button class="slot-btn unavail" disabled=${busy} title=${dd.backup.reasons.join('; ')}
                onClick=${() => overrideDay(dd, 'backup')}>Day off — override…</button>`
            : html`<button class=${'slot-btn ' + (dd.backup.over_target ? 'warn' : dd.backup.status)} disabled=${busy}
                title=${dd.backup.reasons.join('; ')}
                onClick=${() => apply({ day: dd.day, role: 'backup' })}>
                + Backup${dd.backup.status === 'warn' ? ' (flagged)'
                  : dd.backup.over_target ? ' (above target)' : ''}</button>`;
          return html`<tr>
            <td><b>${dd.day}</b></td>
            <td class="muted">${CUR[dd.current] || '—'}</td>
            <td>${roadCell}</td>
            <td>${bkCell}</td></tr>`;
        })}</tbody>
      </table></div>` : ''}

      ${swap ? html`<div class="swap-panel">
        <h4>${swap.day}’s ${swap.want} route${swap.want === 1 ? '' : 's'} are all filled</h4>
        <p class="hint">Pick who steps down to <b>backup</b> that day — ${name} takes their route slot.
          Their day count doesn’t change, only 10h of road becomes a 2h backup.</p>
        ${swap.error ? html`<${Banner} kind="err">${swap.error.message}<//>` : ''}
        ${swap.loading ? html`<p><${Spinner}/> Checking that day’s route drivers…</p>` : ''}
        ${(swap.list || []).map((c) => {
          const meta = TIER_META[c.cls] || TIER_META.free;
          const clickable = c.status !== 'blocked';
          return html`<div class=${'cand ' + c.status}>
            <button class="cand-pick" disabled=${busy || !clickable}
              onClick=${() => clickable && apply({ day: swap.day, role: 'road', swap_name: c.name,
                confirm_unavailable: swap.confirmed })}>${c.name}</button>
            <span class="chip ${meta.chip}">${meta.short}</span>
            <span class="cand-hours">${c.hours}h → ${c.new_hours}h</span>
            <span class="muted">Road: ${c.road_days.join(' ')}${c.backup_days.length ? ' · Bk: ' + c.backup_days.join(' ') : ''}</span>
            ${(c.reasons || []).length ? html`<div class="cand-why">${c.reasons.join('; ')}</div>` : ''}
          </div>`;
        })}
        <div class="row" style="margin-top:10px">
          <button disabled=${busy} onClick=${() => apply({ day: swap.day, role: 'road', extra_route: true,
            confirm_unavailable: swap.confirmed })}>
            Add as an EXTRA route instead (${swap.day} becomes ${swap.want + 1} routes)</button>
          <button disabled=${busy} onClick=${() => setSwap(null)}>← Back to days</button>
        </div>
      </div>` : ''}

      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
        ${busy ? html`<span><${Spinner}/> Applying…</span>` : ''}
      </div>
    </div>
    ${confirm ? html`<${ConfirmOverride} req=${confirm} onCancel=${() => setConfirm(null)}
      onConfirm=${() => { const q = confirm; setConfirm(null); q.run(); }} />` : ''}
  </div>`;
}

// Sticky strip shown above the per-driver table while a move is in progress
// in table view: says what's being moved and offers the escape hatches.
// Modal for moving one driver's shift on one day into a DIFFERENT WAVE.
// Route counts per wave are exact, so a route change is a time swap with a
// driver already in the target wave; backups just relabel.
function WaveEditor({ day, name, onClose, onApplied }) {
  const [st, setSt] = useState({ loading: true, error: null, data: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setSt({ loading: true, error: null, data: null });
    editRequest('wave_options', { day, name }).then((m) => {
      if (!alive) return;
      setSt(m.ok ? { loading: false, error: null, data: m.data }
        : { loading: false, error: m.error, data: null });
    });
    return () => { alive = false; };
  }, [day, name]);

  async function apply(wave, swapName) {
    setBusy(true);
    const m = await editRequest('apply_wave', { day, name, wave, swap_name: swapName });
    setBusy(false);
    if (!m.ok) { setSt((s) => ({ ...s, error: m.error })); return; }
    onApplied(m);
  }

  const d = st.data;
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>Change ${name}’s wave on ${day}</h3>
      ${d ? html`<p class="hint">Now in the <b>${d.current}</b> wave (${d.role === 'road' ? 'route' : 'backup'}).
        ${d.role === 'road'
          ? 'Route counts per wave are exact, so pick who trades times with them.'
          : 'Backups can move to any wave.'}</p>` : ''}

      ${st.error ? html`<${Banner} kind="err">
        ${st.error.message}
        ${st.error.kind === 'no_state' ? html`<div class="hint">Manual edits work on the build from this
          session. Hit “Rebuild with changes” once, then edit.</div>` : ''}
      <//>` : ''}
      ${st.loading ? html`<p><${Spinner}/> Reading that day’s waves…</p>` : ''}

      ${d ? d.waves.map((w) => html`<div class="cand-group">
        <h4 class="cand-h ok">${w.wave} wave</h4>
        ${w.swap_with === null
          ? html`<button class="slot-btn ok" disabled=${busy}
              onClick=${() => apply(w.wave, null)}>Move backup to ${w.wave}</button>`
          : w.swap_with.length === 0
          ? html`<p class="muted" style="margin:4px 0">Nobody is on a plain route in this wave that day.</p>`
          : w.swap_with.map((c) => {
            const meta = TIER_META[c.cls] || TIER_META.free;
            return html`<div class="cand ok">
              <button class="cand-pick" disabled=${busy}
                onClick=${() => apply(w.wave, c.name)}>⇄ ${c.name}</button>
              <span class="chip ${meta.chip}">${meta.short}</span>
              <span class="cand-hours">${c.hours}h</span>
              <span class="muted">takes the ${d.current} spot</span>
            </div>`;
          })}
      </div>`) : ''}

      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
        ${busy ? html`<span><${Spinner}/> Applying…</span>` : ''}
      </div>
    </div>
  </div>`;
}

function MoveBar({ editor, cands, busy, onPick, onClose, onListView, onWave }) {
  const what = editor.role === 'road' ? 'route' : 'backup';
  return html`<div class="movebar">
    <div class="movebar-msg">
      <b>${editor.fromName
        ? `Moving ${editor.fromName}'s ${editor.day} ${what}`
        : `Assigning the open ${editor.day} ${what}`}</b>
      ${cands && cands.loading ? html` <span class="muted"><${Spinner}/> checking every driver against the rules…</span>`
        : cands && cands.error ? ''
        : html` <span class="muted">— green rows can take it, yellow is allowed but flagged, red asked for
          the day off (you'll confirm), grey is locked by a compliance rule.</span>`}
      ${busy ? html` <span class="muted"><${Spinner}/> applying…</span>` : ''}
    </div>
    <div class="movebar-btns">
      <button class="small" disabled=${busy} onClick=${onListView}>Compact list</button>
      ${editor.fromName ? html`<button class="small" disabled=${busy}
        onClick=${onWave}>Change wave…</button>` : ''}
      ${editor.fromName && editor.role === 'backup' ? html`<button class="small" disabled=${busy}
        onClick=${() => onPick(null)}>Remove — leave unfilled</button>` : ''}
      <button class="small" disabled=${busy} onClick=${onClose}>Cancel</button>
    </div>
    ${cands && cands.error ? html`<div class="movebar-err"><${Banner} kind="err">
      ${cands.error.message}
      ${cands.error.kind === 'no_state' ? html`<div class="hint">Manual edits work on the build from this
        session. Hit “Rebuild with changes” once, then edit.</div>` : ''}
    <//></div>` : ''}
  </div>`;
}

// Compact "adjust & rebuild" controls so HR doesn't re-walk all 9 steps.
function QuickAdjust({ wizard, onRebuild }) {
  const roster = wizard.availability?.rosterNames || [];
  const setRow = (name, groupValue) => setWizard((w) => ({
    tierByDriver: { ...w.tierByDriver, [name]: { ...w.tierByDriver[name], groupValue, groupTouched: true } },
  }));
  const setBk = (pct) => setWizard((w) => ({ backups: { ...w.backups, mode: 'pct', pct } }));
  return html`
    <div class="card" style="border-left:4px solid var(--navy)">
      <h3>Adjust & rebuild</h3>
      <p class="hint">Change a driver's days, the backup percentage, or an advanced setting, then rebuild — no need to
        start over. Rebuilding discards any manual edits made above. For availability or route changes, use
        <a href="#" onClick=${(e) => { e.preventDefault(); goStep(0); }}>Week & files</a> /
        <a href="#" onClick=${(e) => { e.preventDefault(); goStep(2); }}>Routes & backups</a>.</p>

      <div class="row" style="margin-bottom:8px">
        <span>Backups:</span>
        <select value=${String(wizard.backups?.pct ?? 0.15)} onChange=${(e) => setBk(Number(e.target.value))}>
          <option value="0.1">10%</option><option value="0.15">15%</option><option value="0.2">20%</option>
        </select>
      </div>

      <div class="scroll-x"><table>
        <thead><tr><th>Driver</th><th>Day target</th></tr></thead>
        <tbody>${roster.map((name) => {
          const gv = wizard.tierByDriver?.[name]?.groupValue || 'exact:3';
          return html`<tr><td>${name}</td>
            <td><select value=${gv} onChange=${(e) => setRow(name, e.target.value)}>
              ${GROUP_OPTIONS.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
            </select></td></tr>`;
        })}</tbody>
      </table></div>

      <${AdvancedPanel} roster=${roster} />
      <button class="accent" style="margin-top:10px" onClick=${onRebuild}>Rebuild with changes</button>
    </div>`;
}

export function Step9Build() {
  const wizard = useStore((s) => s.wizard);
  const b = wizard.build;
  const [progress, setProgress] = useState(null);
  const [editor, setEditor] = useState(null);       // {day, role, fromName, view:'table'|'list'} | null
  const [adder, setAdder] = useState(null);         // {name} | null — the add-a-shift modal
  const [waver, setWaver] = useState(null);         // {day, name} | null — the change-wave modal
  const [cands, setCands] = useState(null);         // {loading, error, list} for the current editor
  const [applying, setApplying] = useState(false);
  const [confirm, setConfirm] = useState(null);     // ConfirmOverride request | null

  // Saved exclusions / trainers / dispatch apply even if that step was skipped.
  useEffect(() => { ensureStanding(); }, []);

  // One candidate fetch per selected slot, shared by the table highlight and
  // the compact list (switching views doesn't refetch).
  const eDay = editor && editor.day, eRole = editor && editor.role, eFrom = editor && editor.fromName;
  useEffect(() => {
    if (!editor) { setCands(null); return undefined; }
    let alive = true;
    setCands({ loading: true, error: null, list: null });
    editRequest('candidates', { day: eDay, role: eRole, from_name: eFrom }).then((msg) => {
      if (!alive) return;
      if (!msg.ok) setCands({ loading: false, error: msg.error, list: null });
      else setCands({ loading: false, error: null, list: msg.data.candidates });
    });
    return () => { alive = false; };
  }, [eDay, eRole, eFrom]);

  // Every successful mutation hands back a fresh report + Excel; swap them in.
  function commitReport(msg, note) {
    setWizard((w) => ({ build: { ...w.build, report: msg.report, xlsx: msg.xlsx } }));
    const log = (msg.report && msg.report.edits) || [];
    toast(note || (log.length ? log[log.length - 1] : 'Edit applied'));
  }

  // Hand the selected slot to `toName` (null = leave it unfilled). A driver
  // who asked for the day off goes through the confirmation dialog first.
  function pickSlot(toName) {
    if (!editor || applying) return;
    const c = toName && cands && cands.list ? cands.list.find((x) => x.name === toName) : null;
    if (c && c.status === 'blocked') return;
    if (c && c.status === 'unavail') {
      setConfirm({ name: toName, day: editor.day, role: editor.role, reasons: c.reasons,
        run: () => applySlot(toName, true) });
      return;
    }
    applySlot(toName, false);
  }

  async function applySlot(toName, confirmUnavailable) {
    if (!editor || applying) return;
    setApplying(true);
    const msg = await editRequest('apply',
      { day: editor.day, role: editor.role, from_name: editor.fromName, to_name: toName,
        confirm_unavailable: !!confirmUnavailable });
    setApplying(false);
    if (!msg.ok) { setCands((c) => ({ ...(c || {}), loading: false, error: msg.error })); return; }
    setEditor(null);
    commitReport(msg);
  }

  // The engine snapshots the state before every edit, so undo restores adds,
  // swaps, and extra routes too — not just simple moves.
  async function undoLast() {
    if (applying) return;
    setApplying(true);
    const msg = await editRequest('undo', {});
    setApplying(false);
    if (!msg.ok) { toast(msg.error.message, 'err'); return; }
    commitReport(msg, 'Undid the last edit');
  }

  const weekNum = parseInt(wizard.week.num, 10);
  const weekLabel = wizard.week.label || 'Schedule';

  async function runBuild() {
    setWizard({ build: { status: 'building', report: null, xlsx: null, error: null } });
    setProgress({ stage: 'start', detail: 'Preparing…' });
    await ensureStanding();
    const wizard = getState().wizard;           // fresh, incl. standing just loaded
    // Fresh trainer-rotation log, so Auto training pairs pick the right person
    // even when Trainers & settings was skipped this session.
    let trainerHistory = wizard.trainerHistory || {};
    try {
      const h = await storeGet('standing/training-history.json');
      if (h && typeof h === 'object') trainerHistory = h;
    } catch { /* use the cached copy */ }
    const { config } = assembleFromWizard({ ...wizard, trainerHistory });

    let prefsText = null;
    if (config.prefs_csv) {
      try { prefsText = await bytesToText(await storeGet('standing/prefs.csv')); } catch { prefsText = null; }
    }
    const files = {
      availBytes: wizard.availability.bytes,
      prevBytes: wizard.priorWeek.bytes || null,
      prefsText,
      configJson: JSON.stringify(config),
    };
    const msg = await build(files, (p) => setProgress(p));
    if (!msg.ok) {
      setWizard({ build: { status: 'error', error: msg.error, report: null, xlsx: null } });
      return;
    }
    setWizard({ build: { status: 'done', report: msg.report, xlsx: msg.xlsx, error: null }, trainerHistory });
    const saved = await saveTrainingHistory(wizard.week.startISO, msg.report.pairlog);
    if (saved) setWizard({ trainerHistory: saved });
  }

  // Not built yet: the old separate Review step sits right here, above the
  // Build button, so checking and building is one screen.
  if (b.status === 'idle') {
    const { nameProblems, config } = assembleFromWizard(wizard);
    const canBuild = nameProblems.length === 0 && Object.keys(config.waves).length > 0;
    return html`<div>
      <div class="card buildcard">
        <div>
          <h2>Build ${weekLabel}</h2>
          <p class="hint">Runs the schedule engine right here in your browser — takes a few seconds.
            ${!canBuild ? html`<b> Fix the items flagged below first.</b>` : ''}</p>
        </div>
        <button class="accent big-btn" disabled=${!canBuild} onClick=${runBuild}>Build schedule</button>
      </div>
      <${Embedded.Provider} value=${true}><${Step8Review} /><//>
      <div class="card navcard"><${StepNav} hideNext=${true} /></div>
    </div>`;
  }

  if (b.status === 'building') {
    return html`<div class="card">
      <h2>Building…</h2>
      <p><${Spinner}/> ${progress ? progress.detail || progress.stage : 'Working…'}</p>
      <p class="hint">The first build in a session takes a little longer while the engine loads (5–15s).</p>
    </div>`;
  }

  if (b.status === 'error') {
    const e = b.error || {};
    return html`<div class="card">
      <h2>The build could not complete</h2>
      ${e.kind === 'config'
        ? html`<${Banner} kind="err">There's a problem with the inputs:<pre class="log">${e.message}</pre><//>`
        : e.kind === 'runtime'
        ? html`<${Banner} kind="err">${e.message}<//>`
        : html`<${Banner} kind="err">The engine hit an unexpected error.<pre class="log">${e.message}</pre><//>`}
      <div class="row">
        <button onClick=${() => setWizard({ build: { status: 'idle', report: null, xlsx: null, error: null } })}>← Back to the check</button>
        <button class="primary" onClick=${runBuild}>Try again</button>
      </div>
    </div>`;
  }

  // done
  const r = b.report;
  const chk = r.check || {};
  const overridden = chk.overridden || [];
  const status = r.clean ? (overridden.length ? `CLEAN — ${overridden.length} manual override${overridden.length === 1 ? '' : 's'}` : 'CLEAN')
    : (chk.errors && chk.errors.length ? 'FAILED' : 'WARNINGS');
  const statusKind = r.clean ? (overridden.length ? 'warn' : 'ok') : (chk.errors && chk.errors.length ? 'err' : 'warn');

  // Rows arrive sorted by hours desc, so each tier's block stays hours-sorted.
  const byTier = {};
  for (const d of (r.drivers || [])) (byTier[d.cls] = byTier[d.cls] || []).push(d);
  const tierSections = TIER_ORDER.filter((t) => byTier[t]);

  // In-table move mode: highlight who can take the selected slot right in the
  // per-driver rows, so the pick is made with full context in view.
  const inTableMove = !!(editor && editor.view === 'table');
  const candMap = (inTableMove && cands && cands.list)
    ? new Map(cands.list.map((c) => [c.name, c])) : null;

  return html`<div>
    <div class="card">
      <h2>${weekLabel}</h2>
      <${Banner} kind=${statusKind}>
        <b>${status}</b> — max consecutive run ${chk.max_consec} (cap 5),
        ${(chk.errors || []).length} error(s), ${(r.infeasible || []).length} unfilled slot warning(s).
      <//>

      <div class="row" style="margin:10px 0">
        <button class="accent" onClick=${() => download(b.xlsx.slice(0), `Week-${weekNum}-Schedule.xlsx`, XLSX_MIME)}>
          Download Week-${weekNum}-Schedule.xlsx</button>
        <button onClick=${() => download(
          new TextEncoder().encode(driverCsv(r, weekLabel)).buffer,
          `Week-${weekNum}-Driver-Notices.csv`, 'text/csv')}>
          Download driver notices (CSV)</button>
      </div>
      <p class="hint">Save the workbook wherever you keep your schedules — you'll upload it as "last week" next time.</p>

      ${(r.infeasible || []).length ? html`<${Banner} kind="warn">
        <b>Some slots could not be filled:</b>
        <ul>${r.infeasible.map((l) => {
          let m = l.match(/P1 INFEASIBLE (\w+)/);
          const slot = m ? { day: m[1], role: 'road' }
            : (m = l.match(/P2 SHORT (\w+)/)) ? { day: m[1], role: 'backup' } : null;
          return html`<li>${translateInfeasible(l)}
            ${slot ? html` <button class="small" onClick=${() =>
              setEditor({ ...slot, fromName: null, view: 'table' })}>Assign someone…</button>` : ''}</li>`;
        })}</ul><//>` : ''}
      ${(r.notes || []).length ? html`<${Banner} kind="info">
        <b>Notes:</b>
        <ul>${r.notes.map((l) => html`<li>${l}</li>`)}</ul><//>` : ''}
      ${(chk.errors || []).length ? html`<${Banner} kind="err">
        <b>Rule violations:</b><ul>${chk.errors.map((l) => html`<li>${l}</li>`)}</ul><//>` : ''}
      ${overridden.length ? html`<${Banner} kind="warn">
        <b>Manual overrides you approved:</b>
        <ul>${overridden.map((l) => html`<li>${translateOverride(l)}</li>`)}</ul>
        <span class="hint">Undo the edit below to take one back.</span><//>` : ''}

      <h3>Per-day fill</h3>
      <div class="scroll-x"><table>
        <thead><tr><th>Day</th><th>Routes</th><th>Backups</th></tr></thead>
        <tbody>${Object.entries(chk.per_day || {}).map(([d, pd]) => html`
          <tr><td>${d}</td><td>${pd.routes}</td><td>${pd.backup}</td></tr>`)}</tbody>
      </table></div>

      <h3>Per-driver</h3>
      <p class="hint">Click any day to move that shift — the table lights up green on everyone who can safely
        take it, and the bar above offers <b>Change wave…</b> for that same shift. The <b>+</b> next to a name
        adds an extra route or backup. Compliance rules (5 days in a row, overtime, worked-day caps) are
        locked; a driver's day off can only be overridden after you confirm it.</p>
      ${editor && editor.view === 'table' ? html`<${MoveBar} editor=${editor} cands=${cands} busy=${applying}
        onPick=${pickSlot} onClose=${() => setEditor(null)}
        onListView=${() => setEditor({ ...editor, view: 'list' })}
        onWave=${() => { setWaver({ day: editor.day, name: editor.fromName }); setEditor(null); }} />` : ''}
      <div class="scroll-x"><table>
        <thead><tr><th>Driver</th><th>Group</th><th>Road</th><th>Backup</th><th>Other</th><th>Hours</th></tr></thead>
        <tbody>${tierSections.map((t) => {
          const meta = TIER_META[t];
          const rows = byTier[t];
          const hrs = rows.map((x) => x.hours);
          const lo = Math.min(...hrs), hi = Math.max(...hrs);
          return html`
            <tr class="tier-sep"><td colspan="6">
              <span class="chip ${meta.chip}">${meta.label}</span>
              <span class="muted"> · ${rows.length} driver${rows.length === 1 ? '' : 's'} · ${lo === hi ? lo + 'h' : lo + '–' + hi + 'h'}</span>
            </td></tr>
            ${rows.map((d) => {
              const other = [...d.helper_days.map((x) => x + ' (train)'),
                ...d.dispatch_days.map((x) => x + ' (disp)'),
                ...d.meeting_days.map((x) => x + ' (mtg)')].join(', ');
              // a 0h driver with submitted days off: say WHY at a glance
              const why = (!other && d.hours === 0 && (d.unavailable || []).length)
                ? `unavailable ${d.unavailable.join(' ')}` : '';

              // Move-mode annotations: is this row the source, a candidate, or blocked?
              const c = candMap ? candMap.get(d.name) : null;
              const isSrc = inTableMove && editor.fromName === d.name;
              const pickable = c && c.status !== 'blocked';
              const rowCls = c ? 'cand-row ' + c.status + (pickable ? ' pickable' : '')
                : isSrc ? 'cand-row src' : '';
              const rowTitle = c
                ? (pickable ? `Give ${d.name} the ${editor.day} ${editor.role === 'road' ? 'route' : 'backup'}`
                    + ((c.reasons || []).length ? ' — ' + c.reasons.join('; ') : '')
                  : 'Locked (compliance): ' + (c.reasons || []).join('; '))
                : undefined;
              // a "+ Fri" target chip in the column the day would land in
              const addChip = (role) => (pickable && editor.role === role)
                ? html`<button class=${'day-chip add' + (c.status === 'warn' || c.status === 'unavail' ? ' ' + c.status : '')}
                    disabled=${applying}
                    title=${(c.reasons || []).join('; ') || rowTitle}
                    onClick=${(e) => { e.stopPropagation(); pickSlot(d.name); }}>+ ${editor.day}${c.status === 'unavail' ? ' (day off)' : ''}</button>`
                : '';
              const blockedWhy = (role) => (c && c.status === 'blocked' && editor.role === role)
                ? html`<span class="cand-inline-why">🔒 ${(c.reasons || [])[0] || ''}</span>` : '';
              // day chips: start a move normally; inert while a move is underway
              const chip = (day, role) => html`<button
                class=${'day-chip' + (role === 'backup' ? ' bk' : '')
                  + (isSrc && editor.day === day && editor.role === role ? ' src' : '')}
                title=${inTableMove ? undefined : `Move this ${role === 'road' ? 'route' : 'backup'} day`}
                onClick=${(e) => { e.stopPropagation();
                  if (!editor) setEditor({ day, role, fromName: d.name, view: 'table' }); }}>${day}</button>`;
              return html`<tr class=${rowCls} title=${rowTitle}
                onClick=${pickable && !applying ? () => pickSlot(d.name) : undefined}>
                <td>${d.name}${!inTableMove ? html` <button class="add-shift"
                  title=${'Add an extra shift for ' + d.name}
                  onClick=${(e) => { e.stopPropagation(); setAdder({ name: d.name }); }}>+</button>` : ''}</td>
                <td><span class="chip ${meta.chip}">${meta.short}${d.target != null ? ':' + d.target : ''}</span></td>
                <td>${d.road_days.length || addChip('road') || blockedWhy('road')
                  ? html`${d.road_days.map((day) => chip(day, 'road'))}${addChip('road')}${blockedWhy('road')}` : '—'}</td>
                <td>${d.backup_days.length || addChip('backup') || blockedWhy('backup')
                  ? html`${d.backup_days.map((day) => chip(day, 'backup'))}${addChip('backup')}${blockedWhy('backup')}` : '—'}</td>
                <td class="muted">${other || why || '—'}</td>
                <td>${pickable
                  ? html`<span class=${'hours-delta' + (c.status === 'warn' || c.status === 'unavail' ? ' ' + c.status : '')}>${c.hours}h → <b>${c.new_hours}h</b></span>`
                  : `${d.hours}h`}</td></tr>`;
            })}`;
        })}</tbody>
      </table></div>

      <h3>Checks</h3>
      <p class="muted">
        Pre-made schedule kept: ${chk.seed_pct == null ? 'n/a' : chk.seed_pct + '%'} ·
        Usual-day adherence: ${chk.usual_pct == null ? 'n/a' : chk.usual_pct + '%'} ·
        Fair-driver hours: ${chk.pool ? `${chk.pool.min}–${chk.pool.max} (avg ${chk.pool.avg})` : 'n/a'}
      </p>
      ${(chk.fifth_day || []).length ? html`<p class="muted">42h fifth-day backups: ${chk.fifth_day.map((x) => x[0]).join(', ')}</p>` : ''}
      ${(r.pairlog || []).length ? html`<p class="muted">Training days: ${r.pairlog.map((p) => `${p[1]} drives ${p[2]} with ${p[0]}`).join('; ')}</p>` : ''}

      <details style="margin-top:10px"><summary>Full verification log</summary>
        <pre class="log">${r.summary_text}</pre></details>
    </div>

    ${(r.edits || []).length ? html`<div class="card" style="border-left:4px solid var(--ok, #2c7a44)">
      <h3>Manual edits (${r.edits.length})</h3>
      <ul>${r.edits.map((e) => html`<li class=${e.includes('[OVERRIDE') ? 'edit-override' : ''}>${e}</li>`)}</ul>
      <p class="hint">Already reflected in the checks above and in the Excel download.
        Rebuilding re-runs the engine and discards these edits.</p>
      ${r.can_undo ? html`<button disabled=${applying} onClick=${undoLast}>Undo last edit</button>` : ''}
    </div>` : ''}

    ${editor && editor.view === 'list' ? html`<${SlotEditor} editor=${editor} cands=${cands} busy=${applying}
      onPick=${pickSlot} onClose=${() => setEditor(null)}
      onTableView=${() => setEditor({ ...editor, view: 'table' })} />` : ''}

    ${confirm ? html`<${ConfirmOverride} req=${confirm} onCancel=${() => setConfirm(null)}
      onConfirm=${() => { const q = confirm; setConfirm(null); q.run(); }} />` : ''}

    ${waver ? html`<${WaveEditor} day=${waver.day} name=${waver.name} onClose=${() => setWaver(null)}
      onApplied=${(m) => { setWaver(null); commitReport(m); }} />` : ''}

    ${adder ? html`<${AddEditor} name=${adder.name} onClose=${() => setAdder(null)}
      onApplied=${(m) => { setAdder(null); commitReport(m); }} />` : ''}

    <${QuickAdjust} wizard=${wizard} onRebuild=${runBuild} />

    <div class="card">
      <div class="row">
        <button onClick=${() => setState({ route: 'home' })}>Done — back to overview</button>
      </div>
    </div>
  </div>`;
}

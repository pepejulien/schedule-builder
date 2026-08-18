import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { useStore, setWizard, setState, continueWizard, toast } from '../store.js';
import { StepNav } from '../app.js';
import { Banner, Spinner, download } from '../ui.js';
import { assembleFromWizard } from '../build-inputs.js';
import { build, editRequest } from '../solver-client.js';
import { storeGet } from '../api.js';
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

// Modal for moving/filling one (day, role) slot. Asks the engine which drivers
// can take it (same rules as the build: unavailability, 5-day streaks, day and
// hour caps, backup rules) and applies the pick — the engine then re-verifies
// everything and regenerates the Excel.
function SlotEditor({ editor, onClose, onApplied }) {
  const { day, role, fromName } = editor;
  const what = role === 'road' ? 'route' : 'backup';
  const [st, setSt] = useState({ loading: true, error: null, cands: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setSt({ loading: true, error: null, cands: null });
    editRequest('candidates', { day, role, from_name: fromName }).then((msg) => {
      if (!alive) return;
      if (!msg.ok) setSt({ loading: false, error: msg.error, cands: null });
      else setSt({ loading: false, error: null, cands: msg.data.candidates });
    });
    return () => { alive = false; };
  }, [day, role, fromName]);

  async function apply(toName) {
    setBusy(true);
    const msg = await editRequest('apply', { day, role, from_name: fromName, to_name: toName });
    setBusy(false);
    if (!msg.ok) { setSt((s) => ({ ...s, error: msg.error })); return; }
    onApplied(msg, { day, role, from_name: fromName, to_name: toName });
  }

  const GROUPS = [
    ['ok', 'Safe — no rule would break'],
    ['warn', 'Allowed, but will be flagged'],
    ['blocked', 'Can’t take it'],
  ];
  const byStatus = {};
  for (const c of (st.cands || [])) (byStatus[c.status] = byStatus[c.status] || []).push(c);

  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>${fromName
        ? `Move the ${day} ${what} — currently ${fromName}`
        : `Assign the open ${day} ${what}`}</h3>
      <p class="hint">Pick who takes it. Green is safe under every rule (availability, 5-day streaks,
        day and hour caps). Grey names can’t take it — the reason is shown.</p>

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
            const days = [
              c.road_days.length ? 'Road: ' + c.road_days.join(' ') : '',
              c.backup_days.length ? 'Bk: ' + c.backup_days.join(' ') : '',
            ].filter(Boolean).join(' · ') || 'no days yet';
            const clickable = status !== 'blocked';
            return html`<div class=${'cand ' + status}>
              <button class="cand-pick" disabled=${busy || !clickable}
                onClick=${() => clickable && apply(c.name)}>${c.name}</button>
              <span class="chip ${meta.chip}">${meta.short}</span>
              <span class="cand-hours">${c.hours}h → ${c.new_hours}h</span>
              <span class="muted">${days}</span>
              ${(c.reasons || []).length ? html`<div class="cand-why">${c.reasons.join('; ')}</div>` : ''}
              ${(c.notes || []).length ? html`<div class="cand-note">${c.notes.join('; ')}</div>` : ''}
            </div>`;
          })}
        </div>`;
      })}

      <div class="row" style="margin-top:12px">
        ${fromName && role === 'backup' ? html`<button disabled=${busy}
          onClick=${() => apply(null)}>Remove — leave this backup slot unfilled</button>` : ''}
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
        ${busy ? html`<span><${Spinner}/> Applying…</span>` : ''}
      </div>
    </div>
  </div>`;
}

// Compact "adjust & rebuild" controls so HR doesn't re-walk all 9 steps.
function QuickAdjust({ wizard, onRebuild }) {
  const roster = wizard.availability?.rosterNames || [];
  const setRow = (name, groupValue) => setWizard((w) => ({
    tierByDriver: { ...w.tierByDriver, [name]: { ...w.tierByDriver[name], groupValue } },
  }));
  const setBk = (pct) => setWizard((w) => ({ backups: { ...w.backups, mode: 'pct', pct } }));
  return html`
    <div class="card" style="border-left:4px solid var(--navy)">
      <h3>Adjust & rebuild</h3>
      <p class="hint">Change a driver's days, the backup percentage, or an advanced setting, then rebuild — no need to
        start over. Rebuilding discards any manual edits made above. For availability or route changes, use
        <a href="#" onClick=${(e) => { e.preventDefault(); continueWizard(); setWizard({ step: 1 }); }}>Availability</a> /
        <a href="#" onClick=${(e) => { e.preventDefault(); continueWizard(); setWizard({ step: 4 }); }}>Route demand</a>.</p>

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
  const [editor, setEditor] = useState(null);       // {day, role, fromName} | null
  const [undoStack, setUndoStack] = useState([]);   // inverse moves, newest last

  // A successful edit hands back a fresh report + Excel; swap them in place.
  function onEditApplied(msg, move) {
    setWizard((w) => ({ build: { ...w.build, report: msg.report, xlsx: msg.xlsx } }));
    setUndoStack((s) => [...s, { day: move.day, role: move.role,
      from_name: move.to_name, to_name: move.from_name }]);
    setEditor(null);
    const log = (msg.report && msg.report.edits) || [];
    toast(log.length ? log[log.length - 1] : 'Edit applied');
  }

  async function undoLast() {
    const inv = undoStack[undoStack.length - 1];
    if (!inv) return;
    const msg = await editRequest('apply', inv);
    if (!msg.ok) { toast(msg.error.message, 'err'); return; }
    setWizard((w) => ({ build: { ...w.build, report: msg.report, xlsx: msg.xlsx } }));
    setUndoStack((s) => s.slice(0, -1));
    toast('Undid the last edit');
  }

  const weekNum = parseInt(wizard.week.num, 10);
  const weekLabel = wizard.week.label || 'Schedule';

  async function runBuild() {
    setWizard({ build: { status: 'building', report: null, xlsx: null, error: null } });
    setProgress({ stage: 'start', detail: 'Preparing…' });
    const { config } = assembleFromWizard(wizard);

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
    setWizard({ build: { status: 'done', report: msg.report, xlsx: msg.xlsx, error: null } });
  }

  if (b.status === 'idle') {
    return html`<div class="card">
      <h2>Step 9 — Build the schedule</h2>
      <p class="hint">This runs the schedule engine right here in your browser. The tiers you fetched are the only
        thing that ever left your device.</p>
      <button class="accent" onClick=${runBuild}>Build ${weekLabel}</button>
      <${StepNav} hideNext=${true} />
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
        <button onClick=${() => { continueWizard(); setWizard({ step: 7 }); }}>← Back to review</button>
        <button class="primary" onClick=${runBuild}>Try again</button>
      </div>
    </div>`;
  }

  // done
  const r = b.report;
  const chk = r.check || {};
  const status = r.clean ? 'CLEAN' : (chk.errors && chk.errors.length ? 'FAILED' : 'WARNINGS');
  const statusKind = r.clean ? 'ok' : (chk.errors && chk.errors.length ? 'err' : 'warn');

  // Rows arrive sorted by hours desc, so each tier's block stays hours-sorted.
  const byTier = {};
  for (const d of (r.drivers || [])) (byTier[d.cls] = byTier[d.cls] || []).push(d);
  const tierSections = TIER_ORDER.filter((t) => byTier[t]);

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
              setEditor({ ...slot, fromName: null })}>Assign someone…</button>` : ''}</li>`;
        })}</ul><//>` : ''}
      ${(r.notes || []).length ? html`<${Banner} kind="info">
        <b>Notes:</b>
        <ul>${r.notes.map((l) => html`<li>${l}</li>`)}</ul><//>` : ''}
      ${(chk.errors || []).length ? html`<${Banner} kind="err">
        <b>Rule violations:</b><ul>${chk.errors.map((l) => html`<li>${l}</li>`)}</ul><//>` : ''}

      <h3>Per-day fill</h3>
      <div class="scroll-x"><table>
        <thead><tr><th>Day</th><th>Routes</th><th>Backups</th></tr></thead>
        <tbody>${Object.entries(chk.per_day || {}).map(([d, pd]) => html`
          <tr><td>${d}</td><td>${pd.routes}</td><td>${pd.backup}</td></tr>`)}</tbody>
      </table></div>

      <h3>Per-driver</h3>
      <p class="hint">Click any day to move that shift to someone else — you’ll see who can safely take it.</p>
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
              return html`<tr>
                <td>${d.name}</td>
                <td><span class="chip ${meta.chip}">${meta.short}${d.target != null ? ':' + d.target : ''}</span></td>
                <td>${d.road_days.length ? d.road_days.map((day) => html`<button
                  class="day-chip" title="Move this route day"
                  onClick=${() => setEditor({ day, role: 'road', fromName: d.name })}>${day}</button>`) : '—'}</td>
                <td>${d.backup_days.length ? d.backup_days.map((day) => html`<button
                  class="day-chip bk" title="Move this backup day"
                  onClick=${() => setEditor({ day, role: 'backup', fromName: d.name })}>${day}</button>`) : '—'}</td>
                <td class="muted">${other || why || '—'}</td>
                <td>${d.hours}h</td></tr>`;
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
      ${(r.pairlog || []).length ? html`<p class="muted">Training pairs: ${r.pairlog.map((p) => `${p[0]}→${p[1]} (${p[2]}→${p[3]})`).join('; ')}</p>` : ''}

      <details style="margin-top:10px"><summary>Full verification log</summary>
        <pre class="log">${r.summary_text}</pre></details>
    </div>

    ${(r.edits || []).length ? html`<div class="card" style="border-left:4px solid var(--ok, #2c7a44)">
      <h3>Manual edits (${r.edits.length})</h3>
      <ul>${r.edits.map((e) => html`<li>${e}</li>`)}</ul>
      <p class="hint">Already reflected in the checks above and in the Excel download.
        Rebuilding re-runs the engine and discards these edits.</p>
      ${undoStack.length ? html`<button onClick=${undoLast}>Undo last edit</button>` : ''}
    </div>` : ''}

    ${editor ? html`<${SlotEditor} editor=${editor}
      onClose=${() => setEditor(null)} onApplied=${onEditApplied} />` : ''}

    <${QuickAdjust} wizard=${wizard} onRebuild=${runBuild} />

    <div class="card">
      <div class="row">
        <button onClick=${() => setState({ route: 'home' })}>Done — back to overview</button>
      </div>
    </div>
  </div>`;
}

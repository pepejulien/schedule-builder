import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { useStore, setWizard, setState, continueWizard } from '../store.js';
import { StepNav } from '../app.js';
import { Banner, Spinner, download } from '../ui.js';
import { assembleFromWizard } from '../build-inputs.js';
import { build } from '../solver-client.js';
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

// Compact "adjust & rebuild" controls so HR doesn't re-walk all 9 steps.
function QuickAdjust({ wizard, onRebuild }) {
  const roster = wizard.availability?.rosterNames || [];
  const setRow = (name, groupValue) => setWizard((w) => ({
    tierByDriver: { ...w.tierByDriver, [name]: { ...w.tierByDriver[name], groupValue } },
  }));
  const setBk = (pct) => setWizard((w) => ({ backups: { ...w.backups, mode: 'pct', pct } }));
  return html`
    <div class="card" style="border-left:4px solid var(--navy)">
      <h3>Adjust &amp; rebuild</h3>
      <p class="hint">Change a driver's days, the backup percentage, or an advanced setting, then rebuild — no need to
        start over. For availability or route changes, use
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

  // Group the per-driver rows by day-target tier, highest tier at the top, so
  // hours can be eyeballed per tier at a glance. Rows arrive sorted by hours
  // desc, so each tier's block stays hours-sorted. Chip colors match the tiers.
  const TIER_META = {
    most: { label: 'Top / Solid', chip: 'green' },
    free: { label: 'Fair (free pool)', chip: 'lav' },
    reduced: { label: 'Underperforming / Termination', chip: 'gray' },
    exact: { label: 'Exact / pinned', chip: 'blue' },
  };
  const TIER_ORDER = ['most', 'free', 'reduced', 'exact'];
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
        <ul>${r.infeasible.map((l) => html`<li>${translateInfeasible(l)}</li>`)}</ul><//>` : ''}
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
                <td><span class="chip ${meta.chip}">${d.cls}${d.target != null ? ':' + d.target : ''}</span></td>
                <td>${d.road_days.join(' ') || '—'}</td>
                <td>${d.backup_days.join(' ') || '—'}</td>
                <td class="muted">${other || why || '—'}</td>
                <td>${d.hours}h</td></tr>`;
            })}`;
        })}</tbody>
      </table></div>

      <h3>Checks</h3>
      <p class="muted">
        Pre-made schedule kept: ${chk.seed_pct == null ? 'n/a' : chk.seed_pct + '%'} ·
        Usual-day adherence: ${chk.usual_pct == null ? 'n/a' : chk.usual_pct + '%'} ·
        Regular-pool hours: ${chk.pool ? `${chk.pool.min}–${chk.pool.max} (avg ${chk.pool.avg})` : 'n/a'}
      </p>
      ${(chk.fifth_day || []).length ? html`<p class="muted">42h fifth-day backups: ${chk.fifth_day.map((x) => x[0]).join(', ')}</p>` : ''}
      ${(r.pairlog || []).length ? html`<p class="muted">Training pairs: ${r.pairlog.map((p) => `${p[0]}→${p[1]} (${p[2]}→${p[3]})`).join('; ')}</p>` : ''}

      <details style="margin-top:10px"><summary>Full verification log</summary>
        <pre class="log">${r.summary_text}</pre></details>
    </div>

    <${QuickAdjust} wizard=${wizard} onRebuild=${runBuild} />

    <div class="card">
      <div class="row">
        <button onClick=${() => setState({ route: 'home' })}>Done — back to overview</button>
      </div>
    </div>
  </div>`;
}

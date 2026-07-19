import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { useStore } from '../store.js';
import { StepNav } from '../app.js';
import { Banner } from '../ui.js';
import { assembleFromWizard } from '../build-inputs.js';
import { DAYS } from '../lib/waves.js';
import { AdvancedPanel } from './advanced-panel.js';

export function Step8Review() {
  const wizard = useStore((s) => s.wizard);
  const [showJson, setShowJson] = useState(false);
  const { config, nameProblems, capacity } = assembleFromWizard(wizard);
  const roster = wizard.availability?.rosterNames || [];

  const opDays = DAYS.filter((d) => config.waves[d]);
  const routeTotal = capacity.routeTotal;
  const canBuild = nameProblems.length === 0 && opDays.length > 0;

  return html`
    <div class="card">
      <h2>Step 8 — Review before building</h2>
      <p class="hint">A quick sanity check of what the schedule engine will run.</p>

      ${nameProblems.length ? html`
        <${Banner} kind="err">
          <b>Some names don't match the roster</b> and would stop the build:
          <ul>${nameProblems.map((p) => html`<li>${p.name} — ${p.reason}</li>`)}</ul>
          Fix these in Step 3 (tiers &amp; names) or Step 7 (standing settings).
        <//>` : ''}

      <h3>Week</h3>
      <p>${config.week_label || '(no label)'} · starts ${config.start_date}</p>

      <h3>Route demand (schedule times)</h3>
      <div class="scroll-x"><table>
        <thead><tr><th>Day</th><th>Waves</th><th>Routes</th><th>Backups</th></tr></thead>
        <tbody>${opDays.map((d) => {
          const w = config.waves[d];
          const routes = Object.values(w).reduce((a, b) => a + b, 0);
          const bk = config.backup_per_day ? config.backup_per_day[d]
            : Math.round(routes * config.backup_pct);
          return html`<tr>
            <td>${d}</td>
            <td class="mono">${Object.entries(w).map(([t, n]) => `${n}@${t}`).join(', ')}</td>
            <td>${routes}</td><td>${bk}</td></tr>`;
        })}</tbody>
      </table></div>
      <p class="muted">Total routes this week: <b>${routeTotal}</b></p>

      <h3>Day-target groups</h3>
      <p>
        <span class="chip green">Most days</span> ${config.most_days.join(', ') || '—'}<br/>
        <span class="chip gray">Reduced (2, Sun+Sat)</span> ${config.reduced_days.names.join(', ') || '—'}<br/>
        <span class="chip blue">Exact</span> ${Object.entries(config.exact_days).map(([n, v]) => `${n}:${v}`).join(', ') || '—'}<br/>
        <span class="chip lav">Free pool (Fair)</span> the rest
      </p>

      ${config.training_pairs.length ? html`<h3>Training pairs</h3>
        <p>${config.training_pairs.map((p) => `${p.trainer} → ${p.trainee}`).join('; ')}</p>` : ''}
      ${Object.keys(config.extra_worked_days).length ? html`<h3>Dispatch duty</h3>
        <p>${Object.entries(config.extra_worked_days).map(([n, d]) => `${n}: ${d.join('/')}`).join('; ')}</p>` : ''}
      ${config.exclude.length ? html`<p class="muted">Excluded from the sheet: ${config.exclude.join(', ')}</p>` : ''}

      <h3>Capacity check</h3>
      <${Banner} kind=${capacity.ok ? 'ok' : 'warn'}>${capacity.message}<//>
      ${!config.prev_week_file ? html`<${Banner} kind="warn">Building without a prior week — the consecutive-day rule
        won't span the week boundary.<//>` : ''}

      <div style="margin-top:12px">
        <button class="ghost small" onClick=${() => setShowJson(!showJson)}>${showJson ? 'Hide' : 'Show'} raw config</button>
        ${showJson ? html`<pre class="log">${JSON.stringify(config, null, 2)}</pre>` : ''}
      </div>
    </div>
    <${AdvancedPanel} roster=${roster} />
    <div class="card">
      <${StepNav} canNext=${canBuild} nextLabel="Build schedule" />
    </div>`;
}

import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { useStore } from '../store.js';
import { StepNav, Embedded } from '../app.js';
import { useContext } from 'preact/hooks';
import { Banner } from '../ui.js';
import { assembleFromWizard } from '../build-inputs.js';
import { DAYS } from '../lib/waves.js';
import { AdvancedPanel } from './advanced-panel.js';
import { WHY_LABEL } from '../lib/driver-prefs.js';

const PREFS_FAILED = "Couldn't read driver preferences — this build doesn't use them.";

// "From Driver preferences": what the Drivers page + requested days off put
// into this week's build.
function PrefsCard({ info, loaded, failed }) {
  if (failed) return html`<div class="card"><h3>From Driver preferences</h3><${Banner} kind="warn">${PREFS_FAILED}<//></div>`;
  if (!loaded) return html`<div class="card"><h3>From Driver preferences</h3><p class="muted">Loading driver preferences…</p></div>`;
  const notOn = new Set(info.unmatched);
  const off = Object.entries(info.off).filter(([n]) => !notOn.has(n));
  const limits = Object.entries(info.limits).filter(([n]) => !notOn.has(n));
  const why = (v) => (WHY_LABEL[v.why] || v.why).toLowerCase();
  const limitText = (L) => [L.maxDays ? `${L.maxDays} day${L.maxDays === 1 ? '' : 's'} max` : '',
    L.maxRow ? `${L.maxRow} in a row max` : ''].filter(Boolean).join(', ');
  const nothing = !off.length && !limits.length && !notOn.size;
  return html`<div class="card">
    <h3>From Driver preferences</h3>
    ${nothing ? html`<p class="muted">No driver preferences or days off for this week.</p>` : ''}
    ${off.length ? html`<p><span class="chip gray">Days off (Unavailable)</span></p><ul>
      ${off.map(([n, days]) => html`<li>${n} — ${DAYS.filter((d) => days[d]).map((d) => `${d} (${why(days[d])})`).join(', ')}</li>`)}</ul>` : ''}
    ${limits.length ? html`<p><span class="chip blue">Limits</span></p><ul>
      ${limits.map(([n, L]) => html`<li>${n} — ${limitText(L)}</li>`)}</ul>` : ''}
    ${notOn.size ? html`<p class="muted">Not on this week's roster: ${[...notOn].join(', ')}</p>` : ''}
  </div>`;
}

export function Step8Review() {
  const wizard = useStore((s) => s.wizard);
  const [showJson, setShowJson] = useState(false);
  const embedded = useContext(Embedded);
  const { config, nameProblems, capacity, warnings: allWarnings, prefsInfo } = assembleFromWizard(wizard);
  const warnings = allWarnings.filter((w) => w !== PREFS_FAILED);   // shown in the prefs card instead
  const prefsLoaded = !!wizard.driverPrefs && wizard.weekTimeoffISO === wizard.week.startISO;
  const roster = wizard.availability?.rosterNames || [];

  const opDays = DAYS.filter((d) => config.waves[d]);
  const routeTotal = capacity.routeTotal;
  const canBuild = nameProblems.length === 0 && opDays.length > 0;

  return html`
    <div class="card">
      <h2>Before you build</h2>
      <p class="hint">A quick sanity check of what the schedule engine will run.</p>

      ${nameProblems.length ? html`
        <${Banner} kind="err">
          <b>Some names don't match the roster</b> and would stop the build:
          <ul>${nameProblems.map((p) => html`<li>${p.name} — ${p.reason}</li>`)}</ul>
          Fix these in <b>Drivers</b> or <b>Trainers & settings</b>.
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
        <span class="chip green">Most days (base 3, max 4)</span> ${config.most_days.join(', ') || '—'}<br/>
        <span class="chip gray">Reduced (base 1, max 2, Sun+Sat)</span> ${config.reduced_days.names.join(', ') || '—'}<br/>
        <span class="chip blue">Exact</span> ${Object.entries(config.exact_days).map(([n, v]) => `${n}:${v}`).join(', ') || '—'}<br/>
        <span class="chip lav">Fair</span> the rest
      </p>

      ${config.training_pairs.length || config.auto_training.length ? html`<h3>Training pairs</h3>
        <p>${[...config.training_pairs.map((p) => `${p.trainer} → ${p.trainee}`),
          ...config.auto_training.map((p) => `Auto (next up: ${p.pool.slice(0, 3).join(', ') || 'no trainers marked'}) → ${p.trainee}`)]
          .join('; ')}</p>` : ''}
      ${warnings.map((w) => html`<${Banner} kind="warn">${w}<//>`)}
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
    <${PrefsCard} info=${prefsInfo} loaded=${prefsLoaded} failed=${!!wizard.driverPrefsFailed} />
    <${AdvancedPanel} roster=${roster} />
    ${!embedded ? html`<div class="card">
      <${StepNav} canNext=${canBuild} nextLabel="Build schedule" />
    </div>` : ''}`;
}

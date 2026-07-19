import { html } from '../preact-setup.js';
import { useStore, setWizard } from '../store.js';
import { StepNav } from '../app.js';
import { Banner } from '../ui.js';
import { DAYS, DAY_FULL } from '../lib/waves.js';

function routesPerDay(demand) {
  const out = {};
  for (const d of DAYS) {
    const total = (demand[d] || []).reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
    if (total > 0) out[d] = total;
  }
  return out;
}

export function Step6Backups() {
  const demand = useStore((s) => s.wizard.demand);
  const backups = useStore((s) => s.wizard.backups);
  const routes = routesPerDay(demand);
  const opDays = Object.keys(routes);

  const setB = (patch) => setWizard((w) => ({ backups: { ...w.backups, ...patch } }));

  const pctCount = (d) => Math.round(routes[d] * Number(backups.pct || 0));
  const bandWarn = (d, n) => {
    const r = routes[d];
    if (!r) return false;
    const p = n / r;
    return p < 0.10 || p > 0.20;
  };

  return html`
    <div class="card">
      <h2>Step 6 — Backups</h2>
      <p class="hint">Backups are extra drivers on standby, on top of routes. Jose's band is 10–20% of routes;
        the standing default is 15%.</p>

      <div class="row" style="margin-bottom:10px">
        <label><input type="radio" name="bkmode" checked=${backups.mode === 'pct'}
          onChange=${() => setB({ mode: 'pct' })} /> Percent of routes</label>
        <label><input type="radio" name="bkmode" checked=${backups.mode === 'perday'}
          onChange=${() => setB({ mode: 'perday' })} /> Exact count per day</label>
      </div>

      ${backups.mode === 'pct' ? html`
        <label class="fld"><span>Percent</span>
          <select value=${String(backups.pct)} onChange=${(e) => setB({ pct: Number(e.target.value) })}>
            <option value="0.1">10%</option><option value="0.15">15% (default)</option>
            <option value="0.2">20%</option>
          </select></label>
        <div class="scroll-x"><table>
          <thead><tr><th>Day</th><th>Routes</th><th>Backups (${Math.round(backups.pct * 100)}%)</th></tr></thead>
          <tbody>${opDays.map((d) => html`
            <tr><td>${DAY_FULL[d]}</td><td>${routes[d]}</td><td>${pctCount(d)}</td></tr>`)}</tbody>
        </table></div>
      ` : html`
        <div class="scroll-x"><table>
          <thead><tr><th>Day</th><th>Routes</th><th>Backups</th></tr></thead>
          <tbody>${opDays.map((d) => {
            const n = Number(backups.perDay?.[d] ?? pctCount(d));
            return html`<tr>
              <td>${DAY_FULL[d]}</td><td>${routes[d]}</td>
              <td><input type="text" inputmode="numeric" value=${backups.perDay?.[d] ?? pctCount(d)} style="width:70px"
                onInput=${(e) => setB({ perDay: { ...backups.perDay, [d]: e.target.value.replace(/[^0-9]/g, '') } })} />
                ${bandWarn(d, n) ? html`<span class="chip gray" title="outside 10–20%">out of band</span>` : ''}</td>
            </tr>`;
          })}</tbody>
        </table></div>
        <p class="hint">Values outside the 10–20% band are flagged but allowed.</p>
      `}

      <${StepNav} canNext=${opDays.length > 0} />
    </div>`;
}

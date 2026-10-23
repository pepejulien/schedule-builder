// "Hours check" (Jose 2026-10-23): one white card above the grid, always there for an open week so
// "all clear" shows too. Over 12 hours in a day / 6 days out of 7 / overtime, plus over 60 hours in 7
// days, a day they asked off and 7 days in a row only when they happen. The rows come from
// hours-check-model.js; replaces the rules engine's long problem list on the Live board.
import { html } from '../preact-setup.js';
import { cellInfo } from './live-model.js';
import { hoursCheck, hoursRows } from './hours-check-model.js';

const isRoute = (v) => { const k = cellInfo(v).kind; return k === 'road' || k === 'trainee'; };

// view = the week (summary or engine report); viewRT = the same with Route Tracker clock-outs merged in
export function HoursCheck({ view, viewRT }) {
  const rows = hoursRows(hoursCheck(view.errors || [], {
    days: view.days || [], drivers: (viewRT || view).drivers || [], gridDrivers: view.drivers || [],
    lim: view.limits || {}, isRoute,
  }));
  return html`<div class="card hc-card">
    <h3>Hours check</h3>
    ${rows.map((r) => html`<div class="hc-row" key=${r.key}>
      <div class="hc-label">${r.title}</div>
      <div class=${'hc-val hc-' + r.tone}>
        ${r.none || ''}
        ${r.lead ? html`<div><b>${r.lead}</b></div>` : ''}
        ${r.items.map((t) => html`<div>${t}</div>`)}
      </div>
    </div>`)}
  </div>`;
}

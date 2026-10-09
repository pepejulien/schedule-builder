// "Route Tracker and the schedule don't match" (Jose 2026-10-08): days up to today where Route
// Tracker has a route or backup and the schedule says something else. The cloud writer fills
// blank days by itself; these need a person. The rows come from limits.js rtMismatches().
import { html } from '../preact-setup.js';

export function RtCheck({ rows, onOpen }) {
  if (!(rows || []).length) return '';
  return html`<div class="card ms-card">
    <div class="ms-head">
      <b>Route Tracker and the schedule don't match (${rows.length})</b>
      <div class="muted">Route Tracker shows what really happened. Fix the schedule or Route Tracker so they agree.</div>
    </div>
    ${rows.map((r) => html`<div class="ms-row">
      <div class="ms-who"><b>${r.name}</b> <span class="muted">${r.line.slice(r.name.length)}</span></div>
      ${r.onSchedule ? html`<div class="ms-btns">
        <button class="small" onClick=${() => onOpen({ name: r.name, day: r.day })}>Open day</button></div>` : ''}
    </div>`)}
  </div>`;
}

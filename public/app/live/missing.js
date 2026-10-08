// "Not in Route Tracker — what happened?" (Jose 2026-10-07): someone was scheduled on a day
// that's over, Route Tracker has clock-outs for that day but none for them, and nobody marked
// them off. One click answers it for everyone — the Schedule Builder and Route Tracker write the
// same answer (Firestore schedule_weeks/{week}/confirm). The check itself is limits.js
// missingDays(), shared with Route Tracker and the Vehicle Assigner.
import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { toast } from '../store.js';
import { saveLiveConfirm } from '../api.js';
import { parseISODate } from '../lib/weeks.js';
import { ANSWERS } from './limits.js';

const ROUTES_URL = '/routes/';
const dayName = (iso) => parseISODate(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const shift = (cell) => (/Backup/.test(cell) ? `${cell.replace(/ Backup$/, '')} backup` : cell === 'Dispatch' ? 'dispatch' : `${cell} route`);

export function MissingCheck({ week, missing }) {
  const [busy, setBusy] = useState('');
  const open = (missing || []).filter((m) => !m.answer);
  const worked = (missing || []).filter((m) => m.answer === 'worked');
  if (!open.length && !worked.length) return '';
  const answer = async (m, a, excused) => {
    setBusy(m.date + m.name);
    try {
      await saveLiveConfirm(week, m.name, m.date, a, excused);
      toast(a ? `${m.name.split(/\s+/)[0]}: ${ANSWERS[a].toLowerCase()}${excused ? ' (excused)' : ''} — saved` : 'Asking again');
    } catch (e) { toast('Could not save: ' + (e.message || e), 'err'); }
    setBusy('');
  };
  return html`<div class="card ms-card">
    ${open.length ? html`<div class="ms-head">
      <b>${open.length === 1 ? '1 driver isn\'t in Route Tracker' : `${open.length} drivers aren't in Route Tracker`} — what happened?</b>
      <div class="muted">Scheduled, no clock-out, and not marked off. Until you answer, the day counts as not worked.</div>
    </div>
    ${open.map((m) => html`<div class="ms-row">
      <div class="ms-who"><b>${m.name}</b> <span class="muted">· ${dayName(m.date)} · ${shift(m.cell)}</span></div>
      <div class="ms-btns">
        ${['callout', 'noshow', 'senthome'].map((a) => html`<button class="small" disabled=${!!busy} onClick=${() => answer(m, a)}>${ANSWERS[a]}</button>`)}
        <button class="small" disabled=${!!busy} title="Still goes on the dispatch report, with no attendance points"
          onClick=${() => answer(m, 'callout', true)}>Excused call-off</button>
        <button class="small ms-worked" disabled=${!!busy} onClick=${() => answer(m, 'worked')}>They worked</button>
      </div>
    </div>`)}` : ''}
    ${worked.length ? html`<div class="ms-worked-list">
      <b>Worked, but the out time is missing in Route Tracker:</b>
      ${worked.map((m) => html`<div class="ms-row">
        <div class="ms-who">${m.name} <span class="muted">· ${dayName(m.date)} — ${m.auto ? 'on a route, no out time entered' : `answered by ${m.by || '—'}`};
          counted as ${m.hours}h until it's in</span></div>
        <div class="ms-btns"><a class="small btnlink" href=${ROUTES_URL} target="_blank" rel="noopener">Enter it in Route Tracker</a>
          ${m.auto ? '' : html`<button class="link" disabled=${!!busy} onClick=${() => answer(m, '')}>Undo</button>`}</div>
      </div>`)}
    </div>` : ''}
  </div>`;
}

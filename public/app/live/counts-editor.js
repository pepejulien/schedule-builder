// The day's route / backup counts (Jose 2026-10-09), shared by the Live board and the
// builder's Step 9 (2026-10-23).
import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { Spinner } from '../ui.js';
import { WAVE_COLORS, SHIFT_COLORS } from './live-model.js';
import { parseISODate } from '../lib/weeks.js';

const shortDate = (iso) => { const d = parseISODate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
// "10:05 AM" < "10:25 AM" < "1:05 PM"
export const waveMins = (w) => { const m = String(w).match(/(\d{1,2}):(\d{2}) ([AP]M)/); if (!m) return 9999;
  return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2]; };
export const waveBg = (w) => WAVE_COLORS[String(w).replace(/ [AP]M$/, '')] || SHIFT_COLORS.other;

// Click on a day's "31/33 · bk 7/7" (Jose 2026-10-09): set how many routes each wave has and
// how many backups — adding someone to a full wave raises the count, and this puts Amazon's real
// number back. A wave may go below the drivers already in it (Jose 2026-10-29) — it just shows over.
export function CountsEditor({ info, fills, busy, onSave, onClose }) {
  const waves = Object.keys(info.waves || {}).sort((a, b) => waveMins(a) - waveMins(b));
  const [vals, setVals] = useState(() => Object.fromEntries(waves.map((w) => [w, String(info.waves[w])])));
  const [bk, setBk] = useState(String(info.backup ?? 0));
  const num = (v) => (/^\d+$/.test(String(v).trim()) ? parseInt(v, 10) : null);
  const bad = waves.filter((w) => num(vals[w]) == null);
  const over = waves.filter((w) => !bad.includes(w) && num(vals[w]) < (fills[w] || 0));
  const bkBad = num(bk) == null;
  const total = waves.reduce((t, w) => t + (num(vals[w]) || 0), 0);
  const same = waves.every((w) => num(vals[w]) === info.waves[w]) && num(bk) === info.backup;
  const save = () => onSave({ day: info.day, backup: num(bk),
    waves: Object.fromEntries(waves.map((w) => [w, num(vals[w])])) });
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card" style="width:420px">
      <h3>${info.day} ${shortDate(info.date)} — routes and backups</h3>
      <p class="hint">Set the counts to what Amazon actually has. Adding someone to a full wave gives it one more
        route, so lower it here when that wasn't a real extra route.</p>
      <table class="lv-counts"><thead><tr><th>Wave</th><th>Have</th><th>Routes</th></tr></thead><tbody>
        ${waves.map((w) => html`<tr>
          <td><span class="lv-sw" style=${`background:${waveBg(w)}`}>${w}</span></td>
          <td class="muted">${fills[w] || 0}</td>
          <td><input type="number" min="0" step="1" inputmode="numeric" value=${vals[w]} aria-label=${`${w} routes`}
            class=${bad.includes(w) ? 'bad' : ''} onInput=${(e) => setVals((v) => ({ ...v, [w]: e.target.value }))} /></td>
        </tr>`)}
        <tr class="lv-counts-tot"><td>Routes in all</td><td class="muted">${info.routes_filled}</td><td><b>${total}</b></td></tr>
        <tr><td>Backups</td><td class="muted">${info.backup_filled}</td>
          <td><input type="number" min="0" step="1" inputmode="numeric" value=${bk} aria-label="Backups"
            class=${bkBad ? 'bad' : ''} onInput=${(e) => setBk(e.target.value)} /></td></tr>
      </tbody></table>
      ${bad.length ? html`<p class="lv-note warn">Enter a whole number, 0 or more.</p>` : ''}
      ${over.length ? html`<p class="lv-note">${over.map((w) => `${w}: ${fills[w] || 0} drivers for ${num(vals[w])} routes — it will show over until you move someone.`).join(' ')}</p>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="primary" disabled=${busy || bad.length || bkBad || same} onClick=${save}>${busy ? html`<${Spinner}/> Saving…` : 'Save'}</button>
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
      </div>
    </div>
  </div>`;
}

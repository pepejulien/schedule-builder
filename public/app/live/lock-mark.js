// The 🔒 on a locked day's cell (2026-11-20, lib/locks.js) — the same mark on the future-week grid, the Live
// board (read-only once published) and the builder's Edit-the-week grid.
//   st = {kind: 'ok' | 'off' | 'flag', text}   a flag (not placed, e.g. "locked, no route") is spelled out
//   warn = text of a time-off clash ('' = none): a ⚠ badge
//   onUnlock = the × for whoever may unlock (omit = read-only)
import { html } from '../preact-setup.js';

export function LockMark({ st, warn, onUnlock, busy }) {
  const cls = 'lk-mark' + (st && st.kind !== 'ok' ? ' lk-flag' : '');
  return html`<span class=${cls} title=${st ? st.text : 'Locked: working this day'}>
    <span aria-label="Locked">🔒</span>${st && st.kind === 'flag' ? html`<small>${st.text}</small>` : ''}${
    warn ? html`<span class="lk-warn" title=${warn} aria-label=${warn}>⚠</span>` : ''}${
    onUnlock ? html`<button class="lk-x" type="button" aria-label="Unlock" title="Unlock" disabled=${busy}
      onClick=${(e) => { e.stopPropagation(); onUnlock(); }}>×</button>` : ''}</span>`;
}

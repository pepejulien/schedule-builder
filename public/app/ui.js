// Shared presentational components.
import { html } from './preact-setup.js';

export function Banner({ kind = 'info', children }) {
  return html`<div class=${'banner ' + kind}>${children}</div>`;
}

export function Spinner() {
  return html`<span class="spinner"></span>`;
}

export function TierBadge({ tier }) {
  const cls = {
    'Top performer': 'top', Solid: 'solid', Fair: 'fair',
    Underperforming: 'under', 'Termination review': 'term', Unrated: 'unrated',
  }[tier] || 'unrated';
  const short = {
    'Top performer': 'Top', Solid: 'Solid', Fair: 'Fair',
    Underperforming: 'Under', 'Termination review': 'Term', Unrated: 'Unrated',
  }[tier] || tier || '—';
  return html`<span class=${'tier ' + cls}>${short}</span>`;
}

export function Toast({ toast }) {
  if (!toast) return null;
  return html`<div class=${'toast ' + (toast.kind || 'ok')}>${toast.message}</div>`;
}

// A file drop/upload control.
export function FileInput({ accept, label, onFile }) {
  const onChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onFile(f);
  };
  return html`
    <label class="fld">
      <span>${label}</span>
      <input type="file" accept=${accept} onChange=${onChange} />
    </label>`;
}

export function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsArrayBuffer(file);
  });
}

export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1)); // strip data: prefix
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function download(arrayBuffer, filename, mime = 'application/octet-stream') {
  const blob = new Blob([arrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

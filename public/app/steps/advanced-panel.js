import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { useStore, setWizard } from '../store.js';

const NUM_FIELDS = [
  { key: 'max_primary_days', label: 'Max road days per driver', def: 4 },
  { key: 'weekly_hours_cap', label: 'Weekly road-hours cap', def: 40 },
  { key: 'max_total_days', label: 'Max total worked days', def: 5 },
  { key: 'free_total_days', label: 'Fair roads+backups cap', def: 4 },
  { key: 'max_consecutive', label: 'Max consecutive days', def: 5 },
  { key: 'primary_hours', label: 'Hours per road day', def: 10 },
  { key: 'backup_hours', label: 'Hours per backup day', def: 2 },
];

const TOGGLES = [
  { key: 'use_premade_shifts', label: 'Honor pre-made shifts as seeds', def: true },
  { key: 'weekend_spread', label: 'Spread weekend days (~1 per driver)', def: true },
  { key: 'merge_standing_unavailable', label: 'Merge standing days-off from preferences', def: false },
];

export function AdvancedPanel({ roster = [], startOpen = false }) {
  const adv = useStore((s) => s.wizard.advanced) || {};
  const [open, setOpen] = useState(startOpen);
  const set = (patch) => setWizard((w) => ({ advanced: { ...w.advanced, ...patch } }));
  const changed = Object.keys(adv).length > 0;

  const bee = adv.backup_eligible_extra || [];

  return html`
    <div class="card" style="border-left:4px solid var(--orange)">
      <div class="row" style="justify-content:space-between; cursor:pointer" onClick=${() => setOpen(!open)}>
        <b>Advanced settings — this week only ${changed ? html`<span class="chip gray">customized</span>` : ''}</b>
        <span>${open ? '▾' : '▸'}</span>
      </div>
      ${open ? html`
        <p class="hint">Overrides reset to the standing defaults next week. Leave them alone unless you specifically
          need a one-off change (e.g. cap everyone at 3 days for a light week).</p>
        <div class="grid2">
          ${NUM_FIELDS.map((f) => html`
            <label class="fld"><span>${f.label} <span class="muted">(default ${f.def})</span></span>
              <input type="text" inputmode="numeric" value=${adv[f.key] ?? ''} placeholder=${String(f.def)}
                style="width:100%"
                onInput=${(e) => { const v = e.target.value.trim(); set({ [f.key]: v === '' ? undefined : Number(v) }); }} /></label>`)}
          <label class="fld"><span>Max weekend days per driver <span class="muted">(blank = no cap)</span></span>
            <input type="text" inputmode="numeric" value=${adv.max_weekend_days ?? ''} placeholder="none"
              style="width:100%"
              onInput=${(e) => { const v = e.target.value.trim(); set({ max_weekend_days: v === '' ? undefined : Number(v) }); }} /></label>
        </div>

        <h3>Toggles</h3>
        ${TOGGLES.map((t) => html`
          <label style="display:block; margin:6px 0">
            <input type="checkbox" checked=${adv[t.key] ?? t.def}
              onChange=${(e) => set({ [t.key]: e.target.checked })} /> ${t.label}</label>`)}

        <h3>Backup exceptions (this week)</h3>
        <p class="hint">Named drivers with a day target who may also take a backup in the main fill. Normally empty.</p>
        <div class="row">
          ${bee.map((n) => html`<span class="chip blue">${n}
            <a href="#" onClick=${(e) => { e.preventDefault(); set({ backup_eligible_extra: bee.filter((x) => x !== n) }); }}> ✕</a></span>`)}
          <select value="" onChange=${(e) => { if (e.target.value) set({ backup_eligible_extra: [...bee, e.target.value] }); }}>
            <option value="">+ add a driver</option>
            ${roster.filter((r) => !bee.includes(r)).map((r) => html`<option value=${r}>${r}</option>`)}
          </select>
        </div>

        ${changed ? html`<div style="margin-top:12px">
          <button class="ghost small" onClick=${() => setWizard({ advanced: {} })}>Reset all to standing defaults</button>
        </div>` : ''}
      ` : ''}
    </div>`;
}

import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { useStore, setWizard, toast } from '../store.js';
import { StepNav } from '../app.js';
import { Banner } from '../ui.js';
import { DAYS } from '../lib/waves.js';
import { storeGet, storePutJSON } from '../api.js';

export const DEFAULT_STANDING = {
  exclude: ['Zackary McDonald', 'Rachel Rhoades', 'Greyson Turner'],
  bench: [],
  dispatch: { 'Connor Stephenson': ['Fri', 'Sat'] },
  trainers: ['Alex Keller', 'Barry Hughes', 'Joseph Gebczyk', 'Jade Oakes',
    'Lexie McMillan', 'Connor Stephenson', 'Matthew Dutton'],
  trainingPairs: [],
};

function NameChips({ names, roster, onChange, placeholder }) {
  const [sel, setSel] = useState('');
  const add = (n) => { if (n && !names.includes(n)) onChange([...names, n]); setSel(''); };
  return html`
    <div class="row">
      ${names.map((n) => html`<span class="chip blue">${n}
        <a href="#" onClick=${(e) => { e.preventDefault(); onChange(names.filter((x) => x !== n)); }}> ✕</a></span>`)}
      <select value=${sel} onChange=${(e) => add(e.target.value)}>
        <option value="">${placeholder || '+ add'}</option>
        ${roster.filter((r) => !names.includes(r)).map((r) => html`<option value=${r}>${r}</option>`)}
      </select>
    </div>`;
}

function DayPicker({ days, onChange }) {
  const toggle = (d) => onChange(days.includes(d) ? days.filter((x) => x !== d) : [...days, d]);
  return html`<div class="row">${DAYS.map((d) => html`
    <label class="chip ${days.includes(d) ? 'green' : 'gray'}" style="cursor:pointer">
      <input type="checkbox" checked=${days.includes(d)} onChange=${() => toggle(d)} style="display:none"/>${d}</label>`)}</div>`;
}

export function Step7Standing() {
  const avail = useStore((s) => s.wizard.availability);
  const standing = useStore((s) => s.wizard.standing);
  const roster = avail?.rosterNames || [];
  const [hasPrefs, setHasPrefs] = useState(false);

  useEffect(() => {
    (async () => {
      let cfg = null;
      try { cfg = await storeGet('standing/config.json'); } catch { /* ignore */ }
      const merged = { ...DEFAULT_STANDING, ...(cfg || {}) };
      if (!standing) setWizard({ standing: { ...merged, hasPrefs: false } });
      try { const p = await storeGet('standing/prefs.csv'); setHasPrefs(!!p); } catch { setHasPrefs(false); }
    })();
  }, []);

  if (!standing) return html`<div class="card"><p>Loading standing settings…</p></div>`;

  const set = (patch) => setWizard((w) => ({ standing: { ...w.standing, ...patch } }));
  // roster + any standing names not on this week's roster, for the dropdowns.
  const nameOptions = [...new Set([...roster, ...standing.exclude, ...standing.bench,
    ...Object.keys(standing.dispatch), ...standing.trainers])].sort();

  const save = async () => {
    const { hasPrefs: _h, ...toSave } = standing;
    try { await storePutJSON('standing/config.json', toSave); toast('Standing settings saved'); }
    catch { toast('Could not save settings', 'err'); }
  };

  const dispatchRows = Object.entries(standing.dispatch);

  return html`
    <div class="card">
      <h2>Step 7 — Standing settings</h2>
      <p class="hint">These carry over week to week. Edit as needed — changes are saved for next time.</p>

      <h3>Excluded (removed from the sheet)</h3>
      <p class="hint">Dispatch / management names that should not appear on the schedule at all.</p>
      <${NameChips} names=${standing.exclude} roster=${nameOptions}
        onChange=${(v) => set({ exclude: v })} placeholder="+ exclude a name" />

      <h3>Benched (kept on the sheet, 0 shifts)</h3>
      <${NameChips} names=${standing.bench} roster=${roster}
        onChange=${(v) => set({ bench: v })} placeholder="+ bench a driver" />

      <h3>Dispatch duty (counts as worked, no route)</h3>
      ${dispatchRows.map(([nm, days]) => html`
        <div class="card" style="margin:8px 0; padding:10px 12px">
          <div class="row" style="justify-content:space-between">
            <b>${nm}</b>
            <button class="ghost small" onClick=${() => { const d = { ...standing.dispatch }; delete d[nm]; set({ dispatch: d }); }}>remove</button>
          </div>
          <${DayPicker} days=${days} onChange=${(v) => set({ dispatch: { ...standing.dispatch, [nm]: v } })} />
        </div>`)}
      <select value="" onChange=${(e) => { if (e.target.value) set({ dispatch: { ...standing.dispatch, [e.target.value]: ['Fri', 'Sat'] } }); }}>
        <option value="">+ add a dispatch driver</option>
        ${roster.filter((r) => !(r in standing.dispatch)).map((r) => html`<option value=${r}>${r}</option>`)}
      </select>

      <h3>Training pairs (this week)</h3>
      <p class="hint">A brand-new hire rides two back-to-back days with the same trainer, then drives solo.</p>
      ${standing.trainingPairs.map((p, i) => html`
        <div class="row" style="margin:6px 0">
          <select value=${p.trainer} onChange=${(e) => { const t = standing.trainingPairs.slice(); t[i] = { ...t[i], trainer: e.target.value }; set({ trainingPairs: t }); }}>
            <option value="">trainer…</option>
            ${nameOptions.map((r) => html`<option value=${r}>${r}</option>`)}
          </select>
          <span class="muted">trains</span>
          <select value=${p.trainee} onChange=${(e) => { const t = standing.trainingPairs.slice(); t[i] = { ...t[i], trainee: e.target.value }; set({ trainingPairs: t }); }}>
            <option value="">trainee…</option>
            ${roster.map((r) => html`<option value=${r}>${r}</option>`)}
          </select>
          <button class="ghost small" onClick=${() => set({ trainingPairs: standing.trainingPairs.filter((_, j) => j !== i) })}>remove</button>
        </div>`)}
      <button class="small" onClick=${() => set({ trainingPairs: [...standing.trainingPairs, { trainer: '', trainee: '' }] })}>+ add a training pair</button>

      ${!hasPrefs ? html`<${Banner} kind="info">No Driver-Preferences.csv is saved yet. You can upload one in
        <b>Settings</b> to add week-to-week "usual day" stickiness. It's optional.<//>` : ''}

      <div class="row" style="margin-top:14px">
        <button onClick=${save}>Save standing settings</button>
      </div>

      <${StepNav} onNext=${() => { save(); setWizard({ standing: { ...standing, hasPrefs } }); setWizard((w) => ({ step: 7 })); window.scrollTo(0, 0); }} />
    </div>`;
}

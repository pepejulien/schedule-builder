import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { useStore, setWizard, getState, toast } from '../store.js';
import { StepNav, goStep } from '../app.js';
import { Banner } from '../ui.js';
import { DAYS } from '../lib/waves.js';
import { storeGet, storePutJSON, loadTrainingHistory, timeoffOnce } from '../api.js';
import { readDriverPrefs } from '../lib/driver-prefs.js';
import { AUTO_TRAINER, trainerRotation } from '../lib/config-assemble.js';

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

// Load the saved standing settings (exclusions, trainers, dispatch...) into
// the build if this session hasn't yet — so skipping this step never drops
// them. Safe to call repeatedly.
export async function ensureStanding() {
  if (getState().wizard.standing) return;
  let cfg = null, hasPrefs = false;
  try { cfg = await storeGet('standing/config.json'); } catch { /* defaults */ }
  try { hasPrefs = !!(await storeGet('standing/prefs.csv')); } catch { /* none */ }
  if (!getState().wizard.standing) setWizard({ standing: { ...DEFAULT_STANDING, ...(cfg || {}), hasPrefs } });
}

// Load the Drivers-page preferences and this week's requested days off into
// the build. Prefs are read every call (they change on another page); time off
// is re-read when the week changes, after a failed read, or with force. A
// failed read never blocks a build: it sets driverPrefsFailed / timeoffFailed
// (the review shows a warning) and the build runs with whatever did load.
let prefsLoading = null;
export function ensureDriverPrefs({ force = false } = {}) {
  if (prefsLoading) return prefsLoading.then(() => ensureDriverPrefs({ force }));
  prefsLoading = (async () => {
    const weekISO = getState().wizard.week?.startISO;
    let doc = null, failed = false;
    try { doc = await readDriverPrefs(); } catch { failed = true; }
    let aliases = getState().wizard.nameAliases || {};
    try { const a = await storeGet('standing/aliases.json'); if (a && typeof a === 'object') aliases = a; } catch { /* keep */ }
    const patch = { driverPrefs: doc, driverPrefsFailed: failed, nameAliases: aliases };
    const w = getState().wizard;
    if (weekISO && (force || w.timeoffFailed || w.weekTimeoffISO !== weekISO || !w.weekTimeoff)) {
      let t = null;
      try { t = await timeoffOnce(weekISO); } catch { t = null; }
      // a failed read is not cached as loaded: the next call tries again
      patch.weekTimeoff = t;
      patch.weekTimeoffISO = weekISO;
      patch.timeoffFailed = !t;
    }
    setWizard(patch);
  })().finally(() => { prefsLoading = null; });
  return prefsLoading;
}

export function Step7Standing() {
  const avail = useStore((s) => s.wizard.availability);
  const standing = useStore((s) => s.wizard.standing);
  const history = useStore((s) => s.wizard.trainerHistory);
  const weekISO = useStore((s) => s.wizard.week.startISO);
  const roster = avail?.rosterNames || [];
  const [hasPrefs, setHasPrefs] = useState(false);

  useEffect(() => {
    (async () => {
      await ensureStanding();
      setHasPrefs(!!getState().wizard.standing?.hasPrefs);
      try { const p = await storeGet('standing/prefs.csv'); setHasPrefs(!!p); } catch { setHasPrefs(false); }
      try {
        const h = await loadTrainingHistory();
        if (h && typeof h === 'object') setWizard({ trainerHistory: h });
      } catch { /* rotation falls back to the marked order */ }
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
  const trainers = standing.trainers || [];
  // Rotation line for this week's roster (who the engine tries first).
  const lineup = trainerRotation(trainers.filter((t) => roster.includes(t)), history, weekISO);
  const setPair = (i, patch) => {
    const t = standing.trainingPairs.slice(); t[i] = { ...t[i], ...patch }; set({ trainingPairs: t });
  };

  return html`
    <div class="card">
      <h2>Trainers & settings</h2>
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

      <h3>Trainers</h3>
      <p class="hint">Mark who can train new hires. A training pair set to <b>Auto</b> picks from this list,
        taking turns so the same person isn't always riding along.</p>
      <${NameChips} names=${trainers} roster=${nameOptions}
        onChange=${(v) => set({ trainers: v })} placeholder="+ mark a trainer" />
      ${lineup.length ? html`<p class="muted" style="margin-top:6px">${'Next up: '}${lineup.map((x, i) => html`${i ? ', ' : ''}<b>${x.name}</b>${x.lastWeek
          ? html` <span class="muted">(last trained wk of ${x.lastWeek})</span>` : ' (not yet)'}`)}</p>` : ''}
      ${trainers.length && !lineup.length ? html`<${Banner} kind="warn">None of the marked trainers are on this
        week's roster, so Auto pairs can't be filled.<//>` : ''}

      <h3>Training pairs (this week)</h3>
      <p class="hint">A brand-new hire gets one training day: they drive with the trainer riding along.
        After that they're scheduled like a regular driver. Leave the trainer on <b>Auto</b> to let the
        system pick the next trainer in the rotation who can work that day.</p>
      ${standing.trainingPairs.map((p, i) => html`
        <div class="row" style="margin:6px 0">
          <select value=${p.trainer} onChange=${(e) => setPair(i, { trainer: e.target.value })}>
            <option value=${AUTO_TRAINER}>Auto — rotate trainers</option>
            <option value="">trainer…</option>
            ${trainers.length ? html`<optgroup label="Trainers">
              ${trainers.map((r) => html`<option value=${r}>${r}</option>`)}</optgroup>` : ''}
            <optgroup label="Everyone else">
              ${nameOptions.filter((r) => !trainers.includes(r)).map((r) => html`<option value=${r}>${r}</option>`)}
            </optgroup>
          </select>
          <span class="muted">trains</span>
          <select value=${p.trainee} onChange=${(e) => setPair(i, { trainee: e.target.value })}>
            <option value="">trainee…</option>
            ${roster.map((r) => html`<option value=${r}>${r}</option>`)}
          </select>
          <button class="ghost small" onClick=${() => set({ trainingPairs: standing.trainingPairs.filter((_, j) => j !== i) })}>remove</button>
        </div>`)}
      <button class="small" onClick=${() => set({ trainingPairs: [...standing.trainingPairs, { trainer: AUTO_TRAINER, trainee: '' }] })}>+ add a training pair</button>

      ${!hasPrefs ? html`<${Banner} kind="info">No Driver-Preferences.csv is saved yet. You can upload one in
        <b>Settings</b> to add week-to-week "usual day" stickiness. It's optional.<//>` : ''}

      <div class="row" style="margin-top:14px">
        <button onClick=${save}>Save standing settings</button>
      </div>

      <${StepNav} onNext=${() => { save(); setWizard({ standing: { ...standing, hasPrefs } }); goStep(4); }} />
    </div>`;
}

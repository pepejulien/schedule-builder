import { html } from '../preact-setup.js';
import { useStore, setWizard } from '../store.js';
import { StepNav } from '../app.js';
import { Banner } from '../ui.js';
import { isSunday, weekLabel } from '../lib/weeks.js';

export function Step1Week() {
  const week = useStore((s) => s.wizard.week);
  const okDate = isSunday(week.startISO);
  const okNum = /^\d+$/.test(String(week.num).trim());
  const label = okDate && okNum ? weekLabel(week.num, week.startISO) : '';

  const set = (patch) => setWizard((w) => ({ week: { ...w.week, ...patch, label: '' } }));

  return html`
    <div class="card">
      <h2>Step 1 — Which week?</h2>
      <p class="hint">Enter the week number and the Sunday it starts on.</p>
      <div class="grid2">
        <label class="fld"><span>Week number</span>
          <input type="text" inputmode="numeric" value=${week.num}
            onInput=${(e) => set({ num: e.target.value.replace(/[^0-9]/g, '') })}
            placeholder="e.g. 41" style="width:100%" /></label>
        <label class="fld"><span>Start date (must be a Sunday)</span>
          <input type="date" value=${week.startISO}
            onInput=${(e) => set({ startISO: e.target.value })} style="width:100%" /></label>
      </div>
      ${week.startISO && !okDate
        ? html`<${Banner} kind="err">That date is not a Sunday. Pick the Sunday the week begins on.<//>` : ''}
      ${label ? html`<${Banner} kind="ok">This will build <b>${label}</b>.<//>` : ''}
      <${StepNav} canNext=${okDate && okNum}
        onNext=${() => { setWizard((w) => ({ week: { ...w.week, label }, step: 1 })); window.scrollTo(0, 0); }} />
    </div>`;
}

import { html } from '../preact-setup.js';
import { useStore, setWizard } from '../store.js';
import { StepNav } from '../app.js';
import { Banner, FileInput, readFileBytes } from '../ui.js';

export function Step4PriorWeek() {
  const week = useStore((s) => s.wizard.week);
  const prior = useStore((s) => s.wizard.priorWeek);
  const prevNum = String(parseInt(week.num, 10) - 1);

  const onFile = async (file) => {
    const bytes = await readFileBytes(file);
    setWizard({ priorWeek: { bytes, source: 'upload', fileName: file.name } });
  };

  return html`
    <div class="card">
      <h2>Step 4 — Last week's schedule</h2>
      <p class="hint">Upload last week's built schedule (Week-${prevNum}) from your own files. It's needed to enforce
        the "max 5 days in a row" rule across the week boundary.</p>

      ${prior.source === 'upload' ? html`
        <${Banner} kind="ok">Using <b>${prior.fileName}</b>.<//>
        <button class="ghost" onClick=${() => setWizard({ priorWeek: { bytes: null, source: null } })}>Choose a different file</button>
      ` : prior.source === 'none' ? html`
        <${Banner} kind="warn">Building <b>without</b> a prior week — the consecutive-day rule cannot be
          checked across the week boundary. Only do this for the very first week.<//>
        <button class="ghost" onClick=${() => setWizard({ priorWeek: { bytes: null, source: null } })}>Undo</button>
      ` : html`
        <${FileInput} accept=".xlsx" label=${'Last week\'s schedule (Week-' + prevNum + '-Schedule.xlsx)'} onFile=${onFile} />
        <button class="ghost" onClick=${() => setWizard({ priorWeek: { bytes: null, source: 'none' } })}>Continue without a prior week (first week only)</button>
      `}

      <${StepNav} canNext=${prior.bytes != null || prior.source === 'none'} />
    </div>`;
}

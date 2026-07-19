import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { useStore, setWizard } from '../store.js';
import { StepNav } from '../app.js';
import { Banner, FileInput, readFileBytes } from '../ui.js';
import { parseAvailability } from '../lib/availability-parse.js';
import { warmup } from '../solver-client.js';
import { DAYS } from '../lib/waves.js';

function DayCell({ cell }) {
  if (!cell || !cell.kind) return html`<td></td>`;
  if (cell.kind === 'unavail') return html`<td class="cell-unavail">Unavail</td>`;
  if (cell.kind === 'meeting') return html`<td class="cell-meet" title=${cell.text}>Meeting</td>`;
  return html`<td class="cell-seed" title=${cell.text}>seed</td>`;
}

export function Step2Availability() {
  const avail = useStore((s) => s.wizard.availability);
  const [err, setErr] = useState('');

  const onFile = async (file) => {
    setErr('');
    const bytes = await readFileBytes(file);
    const parsed = parseAvailability(bytes);
    if (parsed.error) { setErr(parsed.error); return; }
    setWizard({
      availability: {
        fileName: file.name,
        bytes,
        drivers: parsed.drivers,
        counts: parsed.counts,
        rosterNames: parsed.drivers.map((d) => d.name),
        sheetName: parsed.sheetName,
      },
    });
    // Start the Pyodide worker now — earliest moment we know a build is coming.
    warmup();
  };

  return html`
    <div class="card">
      <h2>Step 2 — This week's availability</h2>
      <p class="hint">Upload the <b>Week-NN</b> "Shifts &amp; Availability" workbook drivers submitted. Cells marked
        <i>Unavailable</i> are hard days off; other pre-filled shifts are treated as your draft (seeds).</p>
      <${FileInput} accept=".xlsx" label="Availability workbook (.xlsx)" onFile=${onFile} />
      ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
      ${avail ? html`
        <${Banner} kind="ok">
          Loaded <b>${avail.fileName}</b>: ${avail.counts.drivers} drivers,
          ${avail.counts.unavail} unavailable days, ${avail.counts.seed} seed days,
          ${avail.counts.meeting} meeting cells. The schedule engine is warming up in the background.
        <//>
        <h3>Roster preview</h3>
        <div class="scroll-x"><table>
          <thead><tr><th>Driver</th>${DAYS.map((d) => html`<th>${d}</th>`)}</tr></thead>
          <tbody>${avail.drivers.map((dr) => html`
            <tr><td>${dr.name}</td>${DAYS.map((d) => html`<${DayCell} cell=${dr.days[d]} />`)}</tr>`)}</tbody>
        </table></div>
        <p class="hint">This preview is for your review only — the schedule engine reads the original file directly.</p>
      ` : ''}
      <${StepNav} canNext=${!!avail} />
    </div>`;
}

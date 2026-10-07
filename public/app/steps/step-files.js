// Step 1 — the week and BOTH weekly files in one place. HR drops this week's
// availability export and last week's schedule together (in any order); the
// app works out which is which, fills in the week number / start Sunday, and
// pre-fills the route demand from last week. On the JAJB site last week can
// come straight from the Live board instead (with its midweek changes).
import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { useStore, setWizard, toast } from '../store.js';
import { StepNav, goStep, STEPS } from '../app.js';
import { Banner, Spinner, Icon, readFileBytes } from '../ui.js';
import { warmup, editRequest } from '../solver-client.js';
import { canLive, liveWeek } from '../api.js';
import { loadEngine, prevISO } from '../live/live-model.js';
import { DAYS } from '../lib/waves.js';
import { isSunday, weekLabel } from '../lib/weeks.js';
import { inspectWorkbook, pairUp } from '../lib/file-detect.js';
import { demandFromPrevSchedule } from '../lib/demand-prefill.js';

function DayCell({ cell }) {
  if (!cell || !cell.kind) return html`<td></td>`;
  if (cell.kind === 'unavail') return html`<td class="cell-unavail">Off</td>`;
  if (cell.kind === 'meeting') return html`<td class="cell-meet" title=${cell.text}>Meeting</td>`;
  return html`<td class="cell-seed" title=${cell.text}>${cell.text}</td>`;
}

function Slot({ title, sub, file, detail, onClear, children }) {
  return html`
  <div class=${'fslot' + (file ? ' on' : '')}>
    <div class="fslot-ico">${Icon(file ? 'check' : 'file')}</div>
    <div class="fslot-body">
      <div class="fslot-title">${title}</div>
      ${file ? html`<div class="fslot-file">${file}</div><div class="fslot-sub">${detail}</div>`
        : html`<div class="fslot-sub">${sub}</div>`}
      ${children}
    </div>
    ${file ? html`<button class="ghost small" onClick=${onClear}>Remove</button>` : ''}
  </div>`;
}

const withLabel = (week) => ({
  ...week,
  label: /^\d+$/.test(String(week.num)) && isSunday(week.startISO) ? weekLabel(week.num, week.startISO) : '',
});

function availFrom(fileName, bytes, parsed) {
  return {
    fileName, bytes, drivers: parsed.drivers, counts: parsed.counts,
    rosterNames: parsed.drivers.map((d) => d.name), sheetName: parsed.sheetName,
  };
}

export function StepFiles() {
  const week = useStore((s) => s.wizard.week);
  const avail = useStore((s) => s.wizard.availability);
  const prior = useStore((s) => s.wizard.priorWeek);
  const demand = useStore((s) => s.wizard.demand);
  const exact = useStore((s) => !!(s.wizard.advanced && s.wizard.advanced.exact_copy));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);

  async function takeFiles(fileList) {
    const files = [...fileList].filter((f) => /\.xlsx$/i.test(f.name));
    if (!files.length) { setErr('Drop .xlsx files (the availability export and last week\'s schedule).'); return; }
    setBusy(true); setErr('');
    try {
      const items = [];
      for (const f of files.slice(0, 2)) {
        const bytes = await readFileBytes(f);
        items.push({ ...inspectWorkbook(bytes, f.name), fileName: f.name, bytes });
      }
      const bad = items.filter((x) => x.kind === 'unknown');
      if (bad.length) setErr(bad.map((x) => x.error).join(' '));
      let [a, s] = pairUp(items);
      // One file at a time: it fills whichever slot it looks like; if that
      // slot is taken and the other is empty, it goes to the empty one.
      if (items.length === 1 && a && avail && !prior.bytes) { s = a; a = null; }
      if (items.length === 1 && s && prior.bytes && !avail) { a = s; s = null; }
      const patch = {};
      let wk = { ...week };
      if (a) {
        patch.availability = availFrom(a.fileName, a.bytes, a.parsed);
        if (a.weekNum != null) wk.num = String(a.weekNum);
        if (a.sundayISO) wk.startISO = a.sundayISO;
        warmup();
      }
      if (s) {
        patch.priorWeek = { bytes: s.bytes, source: 'upload', fileName: s.fileName };
        // last week's file fills whatever the availability file didn't say
        if (s.weekNum != null && !(a && a.weekNum != null)) wk.num = String(s.weekNum);
        if (s.sundayISO && !(a && a.sundayISO)) wk.startISO = s.sundayISO;
        // Route demand starts from last week's counts (edit in step 3).
        const empty = !Object.values(demand || {}).some((rows) => (rows || []).length);
        if (empty) {
          try {
            const dem = demandFromPrevSchedule(s.bytes);
            if (Object.keys(dem).length) { patch.demand = dem; toast("Route counts pre-filled from last week's schedule"); }
          } catch { /* fill by hand */ }
        }
      }
      patch.week = withLabel(wk);
      setWizard(patch);
    } finally {
      setBusy(false);
    }
  }

  // Last week as it really ran: load it from the Live board into a spare
  // engine slot and write its workbook — the same file HR would upload.
  async function fromLive() {
    const prev = prevISO(week.startISO);
    setBusy(true); setErr('');
    try {
      const d = await liveWeek(prev);
      if (!d) { setErr(`The week before this one (starting ${prev}) isn't on the Live board — drop last week's file instead.`); return; }
      await loadEngine(prev, d.engine, 'hist');
      const m = await editRequest('export_xlsx', {}, 'hist');
      if (!m.ok || !m.xlsx) throw new Error(m.error ? m.error.message : 'no workbook came back');
      const patch = { priorWeek: { bytes: m.xlsx, source: 'upload', fileName: `${d.meta.label} — from the Live board` } };
      const empty = !Object.values(demand || {}).some((rows) => (rows || []).length);
      if (empty) {
        try {
          const dem = demandFromPrevSchedule(m.xlsx);
          if (Object.keys(dem).length) { patch.demand = dem; toast("Route counts pre-filled from last week's schedule"); }
        } catch { /* fill by hand */ }
      }
      setWizard(patch);
    } catch (e) {
      setErr('Could not read last week from the Live board: ' + (e.message || e));
    } finally {
      setBusy(false);
    }
  }

  // Wrong guess? Swap the two files' roles.
  function swap() {
    if (!avail || !prior.bytes) return;
    const a = inspectWorkbook(prior.bytes, prior.fileName);
    if (a.kind === 'unknown') { setErr(a.error); return; }
    setWizard({
      availability: availFrom(prior.fileName, prior.bytes, a.parsed),
      priorWeek: { bytes: avail.bytes, source: 'upload', fileName: avail.fileName },
    });
  }

  const setWeek = (patch) => setWizard((w) => ({ week: withLabel({ ...w.week, ...patch }) }));
  const okDate = isSunday(week.startISO);
  const okNum = /^\d+$/.test(String(week.num).trim());
  const priorOk = prior.bytes != null || prior.source === 'none';
  const canNext = okDate && okNum && !!avail && priorOk;

  return html`
    <div class="card">
      <h2>Week & files</h2>
      <p class="hint">Drop both files here at once — the order doesn't matter. The app figures out which is which,
        reads the week from them, and pre-fills the route counts from last week.</p>

      <label class=${'dropzone' + (drag ? ' drag' : '')}
        onDragOver=${(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave=${() => setDrag(false)}
        onDrop=${(e) => { e.preventDefault(); setDrag(false); takeFiles(e.dataTransfer.files); }}>
        <input type="file" accept=".xlsx" multiple style="display:none"
          onChange=${(e) => { takeFiles(e.target.files); e.target.value = ''; }} />
        <div class="dz-ico">${Icon('upload')}</div>
        <div class="dz-title">${busy ? html`<${Spinner}/> Reading…` : 'Drop the files here, or click to choose'}</div>
        <div class="dz-sub">This week's availability export + last week's schedule (.xlsx)</div>
      </label>
      ${err ? html`<${Banner} kind="err">${err}<//>` : ''}

      <div class="fslots">
        <${Slot} title="This week's availability" sub="The Shifts & Availability export drivers filled in."
          file=${avail && avail.fileName}
          detail=${avail ? `${avail.counts.drivers} drivers · ${avail.counts.unavail} days off · ${avail.counts.seed} pre-filled shifts` : ''}
          onClear=${() => setWizard({ availability: null })} />
        <${Slot} title="Last week's schedule" sub="The Week-NN-Schedule.xlsx this app made last week — for the 5-days-in-a-row rule."
          file=${prior.source === 'upload' ? prior.fileName : prior.source === 'none' ? 'None — first week' : null}
          detail=${prior.source === 'none' ? 'The 5-days-in-a-row rule won\'t look back into last week.' : 'Used for the 5-days-in-a-row rule and last week\'s route counts.'}
          onClear=${() => setWizard({ priorWeek: { bytes: null, source: null } })}>
          ${!prior.source && canLive() && okDate ? html`<button class="small" disabled=${busy} onClick=${fromLive}
            style="margin:2px 0 6px">Get last week from the Live board</button><br />` : ''}
          ${!prior.source ? html`<button class="link" onClick=${() => setWizard({ priorWeek: { bytes: null, source: 'none' } })}>
            No file — this is the very first week</button>` : ''}
        <//>
      </div>
      ${avail && avail.counts.seed > 0 ? html`<div class="card" style="margin-top:12px;border-left:4px solid var(--accent)">
        <b>Already scheduled in Amazon?</b>
        <p class="hint" style="margin:4px 0 8px">This file has ${avail.counts.seed} shifts filled in. Copy them onto the
          Live board exactly as they are — same people, same days, same times — instead of building a new schedule.
          The rules are still checked and shown, nobody is moved.</p>
        ${exact ? html`<${Banner} kind="ok">Exact copy is <b>on</b> for this week.${' '}
            <button class="link" onClick=${() => setWizard((w) => ({ advanced: { ...w.advanced, exact_copy: false } }))}>Turn it off</button><//>`
          : ''}
        <button class="accent" disabled=${!okDate || !week.num}
          onClick=${() => { setWizard((w) => ({ advanced: { ...w.advanced, exact_copy: true } })); goStep(STEPS.length - 1); }}>
          Copy this schedule exactly → Build</button>
        ${!okDate || !week.num ? html`<span class="muted small" style="margin-left:8px">Fill in the week number and its Sunday below first.</span>` : ''}
      </div>` : ''}
      ${avail && prior.bytes ? html`<p class="muted" style="margin:6px 2px 0">Wrong way round?${' '}<button class="link" onClick=${swap}>Swap the two files</button></p>` : ''}

      <h3>Week</h3>
      <div class="grid2">
        <label class="fld"><span>Week number</span>
          <input type="text" inputmode="numeric" value=${week.num}
            onInput=${(e) => setWeek({ num: e.target.value.replace(/[^0-9]/g, '') })}
            placeholder="e.g. 41" style="width:100%" /></label>
        <label class="fld"><span>Starts on (a Sunday)</span>
          <input type="date" value=${week.startISO}
            onInput=${(e) => setWeek({ startISO: e.target.value })} style="width:100%" /></label>
      </div>
      ${week.startISO && !okDate ? html`<${Banner} kind="err">That date is not a Sunday.<//>` : ''}
      ${week.label ? html`<${Banner} kind="ok">Building <b>${week.label}</b>.<//>` : ''}

      ${avail ? html`<details style="margin-top:12px"><summary>Preview the availability (${avail.counts.drivers} drivers)</summary>
        <div class="scroll-x" style="margin-top:8px"><table>
          <thead><tr><th>Driver</th>${DAYS.map((d) => html`<th>${d}</th>`)}</tr></thead>
          <tbody>${avail.drivers.map((dr) => html`
            <tr><td>${dr.name}</td>${DAYS.map((d) => html`<${DayCell} cell=${dr.days[d]} />`)}</tr>`)}</tbody>
        </table></div></details>` : ''}

      <${StepNav} canNext=${canNext} />
    </div>`;
}

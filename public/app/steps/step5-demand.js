import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { useStore, setWizard, toast } from '../store.js';
import { StepNav } from '../app.js';
import { Banner, Spinner, readFileBase64 } from '../ui.js';
import { DAYS, DAY_FULL, portalToSchedule, normalizePortal, parsePortalTime } from '../lib/waves.js';
import { demandFromPrevSchedule } from '../lib/demand-prefill.js';
import { parseScreenshot, canParseScreenshot } from '../api.js';

// The wave times JAJB actually runs; a custom column can be added for odd weeks.
const DEFAULT_TIMES = ['10:45 AM', '11:05 AM', '11:25 AM'];

function dayTotal(rows) {
  return (rows || []).reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
}

// Column set for the grid: every time already present in the demand, else the
// standard three. Always sorted by clock time.
function colsFromDemand(demand) {
  const set = new Set();
  for (const d of DAYS) {
    for (const r of (demand[d] || [])) {
      const t = normalizePortal(r.portalTime);
      if (t) set.add(t);
    }
  }
  if (!set.size) return DEFAULT_TIMES.slice();
  return [...set].sort((a, b) => parsePortalTime(a) - parsePortalTime(b));
}

// One day's rows -> {portalTime: countString}, merging duplicates.
function rowMap(rows) {
  const m = {};
  for (const r of (rows || [])) {
    const t = normalizePortal(r.portalTime);
    const n = parseInt(r.count, 10);
    if (!t || !Number.isFinite(n) || n <= 0) continue;
    m[t] = String((parseInt(m[t], 10) || 0) + n);
  }
  return m;
}

export function Step5Demand() {
  const wizard = useStore((s) => s.wizard);
  const demand = wizard.demand || {};
  const [cols, setCols] = useState(() => colsFromDemand(demand));
  const [newTime, setNewTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [aiErr, setAiErr] = useState('');

  const setCell = (day, t, raw) => setWizard((w) => {
    const dem = w.demand || {};
    const m = rowMap(dem[day]);
    const v = raw.replace(/[^0-9]/g, '');
    if (v && v !== '0') m[t] = v; else delete m[t];
    const rows = Object.keys(m)
      .sort((a, b) => parsePortalTime(a) - parsePortalTime(b))
      .map((c) => ({ portalTime: c, count: m[c] }));
    return { demand: { ...dem, [day]: rows } };
  });

  const copyFrom = (srcDay, dstDay) => setWizard((w) => {
    const dem = w.demand || {};
    return { demand: { ...dem, [dstDay]: (dem[srcDay] || []).map((r) => ({ ...r })) } };
  });

  const clearDay = (day) => setWizard((w) => ({ demand: { ...(w.demand || {}), [day]: [] } }));

  const addCol = () => {
    const t = normalizePortal(newTime);
    if (!t) { toast('Could not read that time — try the portal format, like 10:45 AM', 'err'); return; }
    if (!cols.includes(t)) {
      setCols((c) => [...c, t].sort((a, b) => parsePortalTime(a) - parsePortalTime(b)));
    }
    setNewTime('');
  };

  const rmCol = (t) => {
    setCols((c) => c.filter((x) => x !== t));
    setWizard((w) => {
      const dem = { ...(w.demand || {}) };
      for (const d of DAYS) {
        if (dem[d]) dem[d] = dem[d].filter((r) => normalizePortal(r.portalTime) !== t);
      }
      return { demand: dem };
    });
  };

  const onPrefill = () => {
    try {
      const dem = demandFromPrevSchedule(wizard.priorWeek.bytes);
      if (!Object.keys(dem).length) {
        toast("No route counts could be read from last week's file.", 'err');
        return;
      }
      setWizard({ demand: dem });
      setCols(colsFromDemand(dem));
      setAiErr('');
      setAiNote("Filled in from last week's schedule — adjust whatever changed this week.");
    } catch (err) {
      toast(err.message || "Could not read last week's file.", 'err');
    }
  };

  const onScreenshot = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBusy(true); setAiErr(''); setAiNote('');
    try {
      const b64 = await readFileBase64(file);
      const out = await parseScreenshot(b64, file.type || 'image/png');
      let nd;
      setWizard((w) => {
        nd = { ...(w.demand || {}) };
        for (const day of (out.days || [])) {
          if (!DAYS.includes(day.day)) continue;
          nd[day.day] = (day.waves || []).map((wv) => ({ portalTime: wv.portal_time, count: String(wv.count) }));
        }
        return { demand: nd };
      });
      setCols(colsFromDemand(nd));
      setAiNote('Counts were filled in from the screenshot — please double-check every day before continuing.');
      if (out.warnings && out.warnings.length) setAiNote((s) => s + ' Notes: ' + out.warnings.join('; '));
    } catch (err) {
      setAiErr(err.message || 'Could not read the screenshot. Enter the counts manually.');
    } finally {
      setBusy(false);
    }
  };

  const operating = DAYS.filter((d) => dayTotal(demand[d]) > 0);
  const weekTotal = operating.reduce((s, d) => s + dayTotal(demand[d]), 0);
  const canNext = operating.length > 0
    && DAYS.every((d) => (demand[d] || []).every((r) => !r.portalTime || portalToSchedule(r.portalTime)));

  return html`
    <div class="card">
      <h2>Routes per wave</h2>
      <p class="hint">Type the route count for each <b>portal</b> wave time — the schedule time (20 min earlier)
        is under each column. Leave a day empty for <b>closed</b>. Fill the first day, then use ⧉ to copy it down.</p>

      <div class="row" style="margin:8px 0 14px">
        ${wizard.priorWeek?.bytes ? html`<button class="primary" onClick=${onPrefill}>
          Prefill from last week's schedule</button>` : ''}
        ${canParseScreenshot() ? html`<label class="fld" style="margin:0"><span>…or parse a portal screenshot</span>
          <input type="file" accept="image/*" onChange=${onScreenshot} disabled=${busy} /></label>` : ''}
        ${busy ? html`<span><${Spinner}/> Reading screenshot…</span>` : ''}
      </div>
      ${aiNote ? html`<${Banner} kind="warn">${aiNote}<//>` : ''}
      ${aiErr ? html`<${Banner} kind="err">${aiErr}<//>` : ''}

      <div class="scroll-x"><table class="demand-grid">
        <thead><tr>
          <th>Day</th>
          ${cols.map((t) => html`<th>
            <div>${t}</div>
            <div class="muted" style="font-weight:400">sched ${portalToSchedule(t)}</div>
            <button class="ghost small" title=${'Remove the ' + t + ' column'}
              onClick=${() => rmCol(t)}>×</button>
          </th>`)}
          <th>Total</th>
          <th></th>
        </tr></thead>
        <tbody>${DAYS.map((day, di) => {
          const m = rowMap(demand[day]);
          const total = dayTotal(demand[day]);
          return html`<tr>
            <td><b>${DAY_FULL[day]}</b></td>
            ${cols.map((t) => html`<td>
              <input type="text" inputmode="numeric" value=${m[t] || ''}
                onInput=${(e) => setCell(day, t, e.target.value)} />
            </td>`)}
            <td>${total > 0
              ? html`<span class="chip green">${total}</span>`
              : html`<span class="chip gray">CLOSED</span>`}</td>
            <td class="row" style="gap:4px; flex-wrap:nowrap">
              ${di > 0 ? html`<button class="ghost small" title=${'Copy ' + DAYS[di - 1] + "'s counts here"}
                onClick=${() => copyFrom(DAYS[di - 1], day)}>⧉ ${DAYS[di - 1]}</button>` : ''}
              ${total > 0 ? html`<button class="ghost small" title="Clear this day (closed)"
                onClick=${() => clearDay(day)}>clear</button>` : ''}
            </td>
          </tr>`;
        })}</tbody>
      </table></div>

      <div class="row" style="margin-top:10px">
        <input type="text" placeholder="another wave time, e.g. 11:45 AM" value=${newTime} style="width:200px"
          onInput=${(e) => setNewTime(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') addCol(); }} />
        <button class="small" onClick=${addCol}>+ add wave time</button>
        <span class="muted" style="margin-left:auto">Week total: <b>${weekTotal}</b>${weekTotal === 1 ? ' route' : ' routes'} across ${operating.length}${operating.length === 1 ? ' day' : ' days'}</span>
      </div>

      ${operating.length === 0 ? html`<${Banner} kind="err">Add route counts for at least one day.<//>` : ''}
      <${StepNav} canNext=${canNext} />
    </div>`;
}

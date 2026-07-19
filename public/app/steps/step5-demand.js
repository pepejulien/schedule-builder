import { html } from '../preact-setup.js';
import { useState } from 'preact/hooks';
import { useStore, setWizard, toast } from '../store.js';
import { StepNav } from '../app.js';
import { Banner, Spinner, readFileBase64 } from '../ui.js';
import { DAYS, DAY_FULL, portalToSchedule } from '../lib/waves.js';
import { parseScreenshot } from '../api.js';

function dayTotal(rows) {
  return (rows || []).reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
}

export function Step5Demand() {
  const demand = useStore((s) => s.wizard.demand);
  const [busy, setBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [aiErr, setAiErr] = useState('');

  const setDemand = (fn) => setWizard((w) => ({ demand: fn(w.demand || {}) }));

  const addWave = (day) => setDemand((d) => ({ ...d, [day]: [...(d[day] || []), { portalTime: '', count: '' }] }));
  const setWave = (day, i, patch) => setDemand((d) => {
    const rows = (d[day] || []).slice();
    rows[i] = { ...rows[i], ...patch };
    return { ...d, [day]: rows };
  });
  const rmWave = (day, i) => setDemand((d) => {
    const rows = (d[day] || []).slice();
    rows.splice(i, 1);
    return { ...d, [day]: rows };
  });

  const onScreenshot = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setBusy(true); setAiErr(''); setAiNote('');
    try {
      const b64 = await readFileBase64(file);
      const out = await parseScreenshot(b64, file.type || 'image/png');
      setDemand((d) => {
        const nd = { ...d };
        for (const day of (out.days || [])) {
          if (!DAYS.includes(day.day)) continue;
          nd[day.day] = (day.waves || []).map((w) => ({ portalTime: w.portal_time, count: String(w.count) }));
        }
        return nd;
      });
      setAiNote('Counts were filled in from the screenshot — please double-check every day before continuing.');
      if (out.warnings && out.warnings.length) setAiNote((s) => s + ' Notes: ' + out.warnings.join('; '));
    } catch (err) {
      setAiErr(err.message || 'Could not read the screenshot. Enter the counts manually.');
    } finally {
      setBusy(false);
    }
  };

  const operating = DAYS.filter((d) => dayTotal(demand[d]) > 0);
  const canNext = operating.length > 0
    && DAYS.every((d) => (demand[d] || []).every((r) => !r.portalTime || portalToSchedule(r.portalTime)));

  return html`
    <div class="card">
      <h2>Step 5 — Route demand</h2>
      <p class="hint">Type the <b>portal</b> wave times and route counts for each operating day. The schedule time is
        20 minutes earlier — shown next to each row. A day with no waves is treated as <b>closed</b>.</p>

      <div class="row" style="margin:8px 0 14px">
        <label class="fld" style="margin:0"><span>Parse from a portal screenshot (optional)</span>
          <input type="file" accept="image/*" onChange=${onScreenshot} disabled=${busy} /></label>
        ${busy ? html`<span><${Spinner}/> Reading screenshot…</span>` : ''}
      </div>
      ${aiNote ? html`<${Banner} kind="warn">${aiNote}<//>` : ''}
      ${aiErr ? html`<${Banner} kind="err">${aiErr}<//>` : ''}

      ${DAYS.map((day) => {
        const rows = demand[day] || [];
        const total = dayTotal(rows);
        return html`
          <div class="card" style="margin:10px 0; padding:12px 14px">
            <div class="row" style="justify-content:space-between">
              <b>${DAY_FULL[day]}</b>
              ${total > 0
                ? html`<span class="chip green">${total} routes</span>`
                : html`<span class="chip gray">CLOSED</span>`}
            </div>
            ${rows.map((r, i) => {
              const sched = r.portalTime ? portalToSchedule(r.portalTime) : null;
              const bad = r.portalTime && !sched;
              return html`
                <div class="row" style="margin-top:8px">
                  <input type="text" placeholder="portal e.g. 10:45 AM" value=${r.portalTime} style="width:150px"
                    onInput=${(e) => setWave(day, i, { portalTime: e.target.value })} />
                  <span class="muted">→ ${bad ? html`<span style="color:var(--err)">unrecognized time</span>` : (sched || 'schedule time')}</span>
                  <input type="text" inputmode="numeric" placeholder="count" value=${r.count} style="width:80px"
                    onInput=${(e) => setWave(day, i, { count: e.target.value.replace(/[^0-9]/g, '') })} />
                  <button class="ghost small" onClick=${() => rmWave(day, i)}>remove</button>
                </div>`;
            })}
            <button class="small" style="margin-top:8px" onClick=${() => addWave(day)}>+ add wave</button>
          </div>`;
      })}

      ${operating.length === 0 ? html`<${Banner} kind="err">Add route counts for at least one day.<//>` : ''}
      <${StepNav} canNext=${canNext} />
    </div>`;
}

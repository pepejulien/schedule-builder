import { html } from './preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { toast } from './store.js';
import { Banner } from './ui.js';
import { storeGet, storeText } from './api.js';
import { getStoredBoardPw, setStoredBoardPw } from './lib/board-fetch.js';
import { xlsxFirstSheetToCsv } from './lib/xlsx-to-csv.js';

export function Settings() {
  const [hasPrefs, setHasPrefs] = useState(false);
  const [pwSet, setPwSet] = useState(!!getStoredBoardPw());
  const [prefsErr, setPrefsErr] = useState('');

  useEffect(() => {
    storeGet('standing/prefs.csv').then((p) => setHasPrefs(!!p)).catch(() => {});
  }, []);

  const onPrefs = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setPrefsErr('');
    let text;
    try {
      if (f.name.toLowerCase().endsWith('.xlsx')) {
        text = xlsxFirstSheetToCsv(await f.arrayBuffer());
      } else {
        text = await f.text();
      }
    } catch { setPrefsErr('That file could not be read.'); return; }

    // Sanity-check: this slot is the driver-PREFERENCES table, not a schedule.
    const firstLine = (text.split(/\r?\n/)[0] || '').toLowerCase();
    if (!firstLine.includes('driver')) {
      setPrefsErr('This doesn\'t look like a driver-preferences table — it needs a "driver" column '
        + '(plus usual_days, often_off_soft, unavailable_hard, weeks_present). '
        + 'If this is a schedule, it goes in Step 4 of a build, not here.');
      return;
    }
    try { await storeText('standing/prefs.csv', text); setHasPrefs(true); toast('Driver preferences saved'); }
    catch { toast('Could not save preferences', 'err'); }
  };

  return html`
    <div class="card">
      <h2>Settings</h2>

      <h3>Driver preferences (optional)</h3>
      <p class="hint">A driver-preferences table adds week-to-week "usual day" stickiness. It's a small table
        with columns: driver, usual_days, often_off_soft, unavailable_hard, weeks_present (pipe-separated day
        lists) — <b>not</b> a schedule. You can upload it as <span class="mono">.csv</span> or
        <span class="mono">.xlsx</span>. This is optional; the app works fine without it.</p>
      ${hasPrefs ? html`<${Banner} kind="ok">A preferences file is saved.<//>` : html`<${Banner} kind="info">No preferences file saved yet.<//>`}
      ${prefsErr ? html`<${Banner} kind="err">${prefsErr}<//>` : ''}
      <label class="fld"><span>Upload / replace preferences (.csv or .xlsx)</span>
        <input type="file" accept=".csv,.xlsx" onChange=${onPrefs} /></label>

      <h3>Driver board password</h3>
      <p class="hint">Stored only on this device. Clear it to be prompted again next time.</p>
      ${pwSet
        ? html`<button onClick=${() => { setStoredBoardPw(''); setPwSet(false); toast('Board password cleared'); }}>Clear saved board password</button>`
        : html`<${Banner} kind="info">No board password saved on this device.<//>`}

      <h3>First-run checklist</h3>
      <ul class="hint">
        <li>Upload the Driver-Preferences.csv above (optional).</li>
        <li>Standing settings (exclusions, dispatch, trainers) are edited in Step 7 of a build.</li>
        <li>For the very first week, upload last week's schedule in Step 4 (there's nothing saved yet).</li>
      </ul>
    </div>`;
}

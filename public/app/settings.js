import { html } from './preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { toast } from './store.js';
import { Banner, download } from './ui.js';
import { storeGet, storeText, exportSettings, importSettings, onFirebase } from './api.js';
import { getStoredBoardPw, setStoredBoardPw } from './lib/board-fetch.js';
import { xlsxFirstSheetToCsv } from './lib/xlsx-to-csv.js';

export function Settings() {
  const [hasPrefs, setHasPrefs] = useState(false);
  const [pwSet, setPwSet] = useState(!!getStoredBoardPw());
  const [prefsErr, setPrefsErr] = useState('');
  const [moveMsg, setMoveMsg] = useState(null);     // {kind, text}

  // Moving sites: one file carries the standing settings, name matches,
  // driver preferences and the trainer-rotation history.
  const onExport = async () => {
    try {
      const data = await exportSettings();
      download(new TextEncoder().encode(JSON.stringify(data, null, 1)).buffer,
        `schedule-builder-settings-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    } catch { toast('Could not export the settings', 'err'); }
  };
  const onImport = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const done = await importSettings(JSON.parse(await f.text()));
      setMoveMsg({ kind: 'ok', text: done.length ? `Loaded: ${done.join(', ')}.` : 'The file had nothing to load.' });
      setHasPrefs(true);
    } catch (err) { setMoveMsg({ kind: 'err', text: err.message || 'That file could not be loaded.' }); }
  };

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
        + 'If this is a schedule, drop it in Week & files of a build, not here.');
      return;
    }
    try { await storeText('standing/prefs.csv', text); setHasPrefs(true); toast('Driver preferences saved'); }
    catch { toast('Could not save preferences', 'err'); }
  };

  return html`
    <div class="card">
      <h2>Settings</h2>

      <h3>Move settings between sites</h3>
      ${onFirebase() ? html`<p class="hint">Bring over everything from the old Netlify Schedule Builder: open it, go to
          <b>Settings → Download all settings</b>, then load that file here. It carries the trainers and other standing
          settings, name matches, driver preferences, and who trained whom.</p>
        <label class="fld"><span>Load a settings file (.json)</span>
          <input type="file" accept=".json,application/json" onChange=${onImport} /></label>`
      : html`<p class="hint">The Schedule Builder is moving to the JAJB site (jajb-ops.web.app/schedule/). Download
          everything here once, then load the file in the new site's Settings.</p>
        <button onClick=${onExport}>Download all settings</button>`}
      ${moveMsg ? html`<${Banner} kind=${moveMsg.kind}>${moveMsg.text}<//>` : ''}

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
        <li>Trainers, exclusions and dispatch duty are edited in Trainers & settings of a build.</li>
        <li>Each week, before it starts, set up next week in Week & files: its availability (from Driver preferences, or the export) and the current week's schedule.</li>
      </ul>
    </div>`;
}

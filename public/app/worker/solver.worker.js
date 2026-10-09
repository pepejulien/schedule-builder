/* Pyodide worker: runs the deterministic Python solver in-browser.
 *
 * Lifecycle:
 *   main thread -> {type:'warmup'}            (fired when Step 2's upload succeeds)
 *   worker      -> {type:'progress', stage, detail?}
 *   worker      -> {type:'ready'}
 *   main thread -> {type:'build', files:{...}}
 *   worker      -> {type:'result', ok, xlsx?, report?, error?}
 *   main thread -> {type:'edit', id, op:'candidates'|'apply', payload:{...}, slot?}
 *   worker      -> {type:'edit-result', id, ok, data?|report?+xlsx?, error?}
 *
 * Slots (2026-10-06): the engine keeps one schedule per slot — 'build' (the
 * wizard, the default), 'live' (the week open on the Live board) and 'hist'
 * (last week, read back for Step 1). Live ops
 * load Pyodide on demand (load_state), and the live slot never rewrites the
 * workbook per edit: op 'export_xlsx' writes it when someone downloads.
 *
 * If Pyodide ever fails to load, bump PYODIDE_VERSION to the current stable
 * release (https://github.com/pyodide/pyodide/releases) — this is the one knob.
 */
const PYODIDE_VERSION = '0.27.2';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// The app's root folder: this worker lives at <root>/app/worker/solver.worker.js.
const APP_ROOT = new URL('../../', self.location.href);

let pyodide = null;
let ready = false;
let warmupPromise = null;

function progress(stage, detail) {
  self.postMessage({ type: 'progress', stage, detail });
}

// Idempotent: returns a single shared promise so a build() that arrives while
// warmup is still running awaits the SAME warmup rather than racing ahead.
function warmup() {
  if (!warmupPromise) warmupPromise = doWarmup();
  return warmupPromise;
}

async function doWarmup() {
  try {
    progress('runtime', 'Loading the Python runtime…');
    importScripts(PYODIDE_BASE + 'pyodide.js');
    // eslint-disable-next-line no-undef
    pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });

    progress('packages', 'Installing the spreadsheet engine…');
    // Paths are relative to the app's own folder, so the same files run at the
    // site root (Netlify) and under /schedule/ (jajb-ops Firebase Hosting).
    const wheels = [
      'et_xmlfile-2.0.0-py3-none-any.whl',
      'openpyxl-3.1.5-py2.py3-none-any.whl',
    ];
    // Fetch each wheel ourselves and verify it's a real zip (starts with 'PK').
    // This avoids micropip's URL downloader (which failed with an internal
    // "attempted to install wheel before downloading it" error), and gives a
    // clear message if the files somehow aren't deployed.
    pyodide.FS.mkdirTree('/wheels');
    for (const wname of wheels) {
      const resp = await fetch(new URL(`pyodide/${wname}`, APP_ROOT));
      if (!resp.ok) throw new Error(`Could not download ${wname} (HTTP ${resp.status}).`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error(`${wname} did not download correctly — the engine files may not be deployed.`);
      }
      pyodide.FS.writeFile(`/wheels/${wname}`, buf);
    }
    // A wheel is just a zip; these are pure-Python, so extracting them straight
    // into site-packages makes them importable — no installer needed.
    pyodide.runPython(
      'import sys, zipfile\n'
      + 'site = next((p for p in sys.path if "site-packages" in p), sys.path[-1])\n'
      + 'for w in ["/wheels/et_xmlfile-2.0.0-py3-none-any.whl", "/wheels/openpyxl-3.1.5-py2.py3-none-any.whl"]:\n'
      + '    with zipfile.ZipFile(w) as z:\n'
      + '        z.extractall(site)\n'
      + 'import openpyxl  # fail fast here if extraction did not work\n',
    );

    progress('solver', 'Loading the schedule builder…');
    const [solverSrc, runnerSrc] = await Promise.all([
      fetch(new URL('solver/build_weekly_schedule.py', APP_ROOT)).then((r) => r.text()),
      fetch(new URL('solver/runner.py', APP_ROOT)).then((r) => r.text()),
    ]);
    pyodide.FS.mkdirTree('/app');
    pyodide.FS.writeFile('/app/build_weekly_schedule.py', solverSrc);
    pyodide.FS.writeFile('/app/runner.py', runnerSrc);
    pyodide.runPython('import sys; sys.path.insert(0, "/app")');
    pyodide.runPython('import runner');
    pyodide.FS.mkdirTree('/work');

    ready = true;
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'result', ok: false, error: {
      kind: 'runtime',
      message: 'The in-browser Python engine failed to load.\n' + (err && err.message ? err.message : String(err)),
    } });
  }
}

async function build(files) {
  await warmup();
  if (!ready) return; // warmup already posted a runtime error
  try {
    const FS = pyodide.FS;
    // Clean any prior inputs so a re-run never uses stale files.
    for (const f of ['avail.xlsx', 'prev.xlsx', 'prefs.csv', 'config.json', 'output.xlsx']) {
      try { FS.unlink('/work/' + f); } catch { /* not present */ }
    }
    FS.writeFile('/work/avail.xlsx', new Uint8Array(files.availBytes));
    if (files.prevBytes) FS.writeFile('/work/prev.xlsx', new Uint8Array(files.prevBytes));
    if (files.prefsText != null) FS.writeFile('/work/prefs.csv', files.prefsText);
    FS.writeFile('/work/config.json', files.configJson);

    pyodide.runPython('runner.use_slot("build")');
    const jsonStr = pyodide.runPython('runner.run("/work/config.json")');
    const report = JSON.parse(jsonStr);

    if (!report.ok) {
      self.postMessage({ type: 'result', ok: false, error: {
        kind: report.kind || 'crash',
        message: report.message || 'The build failed.',
      } });
      return;
    }
    let xlsx = null;
    try {
      const bytes = FS.readFile('/work/output.xlsx'); // Uint8Array
      xlsx = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } catch { /* no output written */ }
    self.postMessage({ type: 'result', ok: true, report, xlsx }, xlsx ? [xlsx] : []);
  } catch (err) {
    self.postMessage({ type: 'result', ok: false, error: {
      kind: 'crash',
      message: (err && err.message ? err.message : String(err)),
    } });
  }
}

// Manual-edit calls only make sense against the build held in the Python
// module's memory (runner._STATE). If the worker isn't ready there is no such
// build, so answer instantly instead of cold-loading Pyodide just to say no.
async function edit(msg) {
  const fail = (error) => self.postMessage({ type: 'edit-result', id: msg.id, ok: false, error });
  const slot = ['live', 'hist'].includes(msg.slot) ? msg.slot : 'build';
  // Opening a saved week is the one edit call that may need the engine loaded.
  if (!ready && msg.op === 'load_state') {
    await warmup();
    if (!ready) { fail({ kind: 'runtime', message: 'The in-browser engine failed to load. Reload the page and try again.' }); return; }
  }
  if (!ready) {
    fail({ kind: 'no_state',
      message: 'The engine has no schedule in memory (the page was reloaded). Rebuild first, then edit.' });
    return;
  }
  // Ops that mutate the schedule hand back a fresh report + xlsx; the rest
  // return plain data.
  const OPS = {
    candidates: 'candidates', add_options: 'add_options', swap_candidates: 'swap_candidates',
    wave_options: 'wave_options',
    apply: 'apply_edit', apply_add: 'apply_add', apply_wave: 'apply_wave', undo: 'undo_last',
    apply_mark: 'apply_mark', clear_mark: 'clear_mark', set_role: 'set_role',
    set_duty: 'set_duty', clear_duty: 'clear_duty', sync_actual: 'sync_actual',
    load_state: 'load_state', export_state: 'export_state', export_xlsx: 'export_xlsx',
  };
  const MUTATING = new Set(['apply', 'apply_add', 'apply_wave', 'undo', 'apply_mark', 'clear_mark', 'set_role', 'set_duty', 'clear_duty', 'sync_actual', 'load_state']);
  // Ops whose answer comes with the slot's workbook bytes.
  const WITH_XLSX = slot === 'build' ? MUTATING : new Set(['export_xlsx']);
  try {
    if (!OPS[msg.op]) {
      fail({ kind: 'edit', message: 'Unknown edit op: ' + msg.op });
      return;
    }
    const runner = pyodide.pyimport('runner');
    runner.use_slot(slot);
    const fn = runner[OPS[msg.op]];
    const out = JSON.parse(fn(JSON.stringify(msg.payload || {})));
    runner.destroy();
    if (out.ok === false) {
      fail({ kind: out.kind || 'edit', message: out.message || 'The edit failed.', full: out.full, limits: out.limits });
      return;
    }
    if (MUTATING.has(msg.op) || WITH_XLSX.has(msg.op)) {
      let xlsx = null;
      try {
        if (!WITH_XLSX.has(msg.op)) throw new Error('no workbook for this op');
        const bytes = pyodide.FS.readFile(out.out || '/work/output.xlsx');
        xlsx = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } catch { /* no output written */ }
      self.postMessage({ type: 'edit-result', id: msg.id, ok: true, report: out, xlsx }, xlsx ? [xlsx] : []);
    } else {
      self.postMessage({ type: 'edit-result', id: msg.id, ok: true, data: out });
    }
  } catch (err) {
    fail({ kind: 'crash', message: (err && err.message ? err.message : String(err)) });
  }
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'warmup') warmup();
  else if (msg.type === 'build') build(msg.files);
  else if (msg.type === 'edit') edit(msg);
};

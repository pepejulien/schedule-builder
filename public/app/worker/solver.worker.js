/* Pyodide worker: runs the deterministic Python solver in-browser.
 *
 * Lifecycle:
 *   main thread -> {type:'warmup'}            (fired when Step 2's upload succeeds)
 *   worker      -> {type:'progress', stage, detail?}
 *   worker      -> {type:'ready'}
 *   main thread -> {type:'build', files:{...}}
 *   worker      -> {type:'result', ok, xlsx?, report?, error?}
 *
 * If Pyodide ever fails to load, bump PYODIDE_VERSION to the current stable
 * release (https://github.com/pyodide/pyodide/releases) — this is the one knob.
 */
const PYODIDE_VERSION = '0.27.2';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

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
    await pyodide.loadPackage('micropip');
    const origin = self.location.origin;
    // deps=False (keyword — the 2nd positional is keep_going, not deps) installs
    // both pure-Python wheels locally with no PyPI round-trip.
    await pyodide.runPythonAsync(
      'import micropip\n'
      + 'await micropip.install([\n'
      + `    "${origin}/pyodide/et_xmlfile-2.0.0-py3-none-any.whl",\n`
      + `    "${origin}/pyodide/openpyxl-3.1.5-py2.py3-none-any.whl",\n`
      + '], deps=False)\n',
    );

    progress('solver', 'Loading the schedule builder…');
    const [solverSrc, runnerSrc] = await Promise.all([
      fetch('/solver/build_weekly_schedule.py').then((r) => r.text()),
      fetch('/solver/runner.py').then((r) => r.text()),
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

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'warmup') warmup();
  else if (msg.type === 'build') build(msg.files);
};

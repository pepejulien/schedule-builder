// Thin promise wrapper around the Pyodide worker. Singleton worker; warm it up
// early (on the availability upload) so Build is fast.

let worker = null;
let ready = false;
let readyWaiters = [];
let progressCb = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/app/worker/solver.worker.js');
  worker.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress') {
      if (progressCb) progressCb(msg);
    } else if (msg.type === 'ready') {
      ready = true;
      readyWaiters.forEach((r) => r());
      readyWaiters = [];
    }
    // 'result' is handled per-build below (temporary listener).
  };
  return worker;
}

export function warmup(onProgress) {
  progressCb = onProgress || progressCb;
  ensureWorker().postMessage({ type: 'warmup' });
}

export function isReady() { return ready; }

export function onProgress(cb) { progressCb = cb; }

// Kill a stuck worker so the next attempt starts cleanly.
function resetWorker() {
  if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
  worker = null;
  ready = false;
  readyWaiters = [];
}

const LOAD_TIMEOUT_MS = 120000; // 2 min — generous for a slow first load

// files: { availBytes:ArrayBuffer, prevBytes:ArrayBuffer|null, prefsText:string|null, configJson:string }
export function build(files, onProgress) {
  const w = ensureWorker();
  if (onProgress) progressCb = onProgress;
  w.postMessage({ type: 'warmup' }); // no-op if already warming/ready
  return new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.removeEventListener('message', handler);
      resolve(msg);
    };
    const handler = (e) => {
      if (e.data && e.data.type === 'result') finish(e.data);
    };
    w.addEventListener('message', handler);
    // Safeguard: if the engine never loads (slow/blocked network), don't spin
    // forever — give up and surface a clear, actionable error.
    timer = setTimeout(() => {
      resetWorker();
      finish({ ok: false, error: { kind: 'runtime',
        message: 'The in-browser engine took too long to load (over 2 minutes). '
          + 'This is almost always a slow or blocked internet connection. '
          + 'Try again, use Chrome or Edge, or switch to a different network (some work/school networks block it).' } });
    }, LOAD_TIMEOUT_MS);
    w.postMessage({ type: 'build', files });
  });
}

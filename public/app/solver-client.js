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

// files: { availBytes:ArrayBuffer, prevBytes:ArrayBuffer|null, prefsText:string|null, configJson:string }
export function build(files, onProgress) {
  const w = ensureWorker();
  if (onProgress) progressCb = onProgress;
  w.postMessage({ type: 'warmup' }); // no-op if already warming/ready
  return new Promise((resolve) => {
    const handler = (e) => {
      const msg = e.data || {};
      if (msg.type === 'result') {
        w.removeEventListener('message', handler);
        resolve(msg);
      }
    };
    w.addEventListener('message', handler);
    w.postMessage({ type: 'build', files });
  });
}

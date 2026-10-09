// Live board speed harness (2026-10-08). TEST ONLY. On the mock site (serve.py, ?lat=300 for
// Firestore-like latency), from the browser console or a test driver:
//   (0, eval)(await fetch('/__mock/perf-harness.js').then((r) => r.text())); await H.seed(); location.reload();
//   then again: (0, eval)(...); await H.load(); await H.scenario()
// Times are from the action to the grid changing ("paint") and to the rules engine being ready again.
// A hidden page never runs requestAnimationFrame (Preact's effects wait on it): a 16 ms timer stands
// in, like a visible 60 fps page.
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.H = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async until(f, ms = 60000) {
    const t = performance.now();
    while (performance.now() - t < ms) { try { const v = f(); if (v) return v; } catch (e) { /* not yet */ } await new Promise((r) => setTimeout(r, 4)); }
    throw new Error('timeout');
  },
  col(day) { const ths = [...document.querySelectorAll('.lv-grid thead th')]; return ths.findIndex((th) => th.textContent.trim().startsWith(day)); },
  row(name) { return [...document.querySelectorAll('.lv-grid tbody tr')].find((tr) => { const b = tr.querySelector('.lv-name'); return b && b.textContent.trim() === name; }); },
  cell(name, day) { const r = H.row(name); return r ? r.children[H.col(day)] : null; },
  wbBtn() { return [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Workbook')); },
  ready() { const b = H.wbBtn(); return b && !b.disabled; },
  saving() { return [...document.querySelectorAll('p, span')].some((e) => e.children.length <= 1 && /Saving…/.test(e.textContent)); },
  calls0: null,
  mark() { H.calls0 = { ...JAJB.__mock.calls }; },
  diff() { const c1 = JAJB.__mock.calls, d = {}; for (const k in c1) if (c1[k] !== (H.calls0[k] || 0)) d[k] = c1[k] - (H.calls0[k] || 0); return d; },
  async openLive() {
    H.mark();
    const t0 = performance.now();
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Live schedule').click();
    await H.until(() => document.querySelector('.lv-grid tbody tr'));
    const paint = performance.now() - t0;
    await H.until(() => H.ready(), 120000);
    return { paint: Math.round(paint), ready: Math.round(performance.now() - t0), calls: H.diff() };
  },
  async remote(i) {
    const lm = await import('/app/live/live-model.js');
    const r = __seed.remotes[i]; const wk = JAJB.__mock.get('weeks')[__seed.week];
    const meta = { ...wk.meta };
    const w = { summary: JSON.stringify(lm.summaryFromReport(r.report, meta)), engine: r.state, label: meta.label, num: meta.num,
      stats: lm.statsFromReport(r.report), log: [{ text: 'remote test ' + r.name, kind: 'mark' }] };
    await H.until(() => H.ready());
    H.mark();
    const t0 = performance.now();
    let notReady = null;
    const watch = setInterval(() => { if (notReady == null && !H.ready()) notReady = performance.now() - t0; }, 2);
    JAJB.__mock.remoteSave(__seed.week, w);
    await H.until(() => H.cell(r.name, r.day).textContent.includes('Called out'));
    const paint = performance.now() - t0;
    await H.until(() => notReady != null && H.ready(), 120000);
    clearInterval(watch);
    return { who: r.name, paint: Math.round(paint), ready: Math.round(performance.now() - t0), calls: H.diff() };
  },
  pick(day, skip = []) {
    const i = H.col(day);
    const tr = [...document.querySelectorAll('.lv-grid tbody tr')].find((x) => x.children[i] && x.children[i].classList.contains('k-road')
      && !skip.includes(x.querySelector('.lv-name').textContent.trim()));
    return tr.querySelector('.lv-name').textContent.trim();
  },
  // own change: a call-out through the day menu; times from the dialog's Save click
  async edit(name, day, opts = {}) {
    await H.until(() => H.ready() && !H.saving());
    H.cell(name, day).click();
    const btn = await H.until(() => [...document.querySelectorAll('.daymodal button')].find((b) => b.textContent.includes('Called out')));
    btn.click();
    const save = await H.until(() => [...document.querySelectorAll('.edit-modal button.primary')].find((b) => b.textContent.trim() === 'Save'));
    if (opts.fail) JAJB.__mock.failNext(opts.fail);
    if (opts.conflict != null) JAJB.__mock.beforeNextSave(async () => { await H.remoteRaw(opts.conflict); });
    H.mark();
    const t0 = performance.now();
    const seen = [];
    const obs = setInterval(() => { const t = H.cell(name, day).textContent; if (seen.length === 0 || seen[seen.length - 1].t !== t) seen.push({ at: Math.round(performance.now() - t0), t }); }, 2);
    save.click();
    let paint = null;
    if (!opts.fail && opts.conflict == null) { await H.until(() => H.cell(name, day).textContent.includes('Called out')); paint = performance.now() - t0; }
    await H.sleep(30);
    await H.until(() => !H.saving() && !document.querySelector('.edit-modal button.primary[disabled]'), 60000);
    const saved = performance.now() - t0;
    await H.until(() => H.ready(), 60000);
    const ready = performance.now() - t0;
    await H.sleep(300);
    clearInterval(obs);
    const toasts = [...document.querySelectorAll('.toast, [class*=toast]')].map((x) => x.textContent.trim()).filter(Boolean);
    return { who: name, paint: paint && Math.round(paint), saved: Math.round(saved), ready: Math.round(ready), cellSeen: seen, calls: H.diff(), toasts };
  },
  // another dispatcher's save, no waiting (for conflicts)
  async remoteRaw(i) {
    const lm = await import('/app/live/live-model.js');
    const r = __seed.remotes[i]; const wk = JAJB.__mock.get('weeks')[__seed.week];
    const meta = { ...wk.meta };
    JAJB.__mock.remoteSave(__seed.week, { summary: JSON.stringify(lm.summaryFromReport(r.report, meta)), engine: r.state,
      label: meta.label, num: meta.num, stats: lm.statsFromReport(r.report), log: [{ text: 'remote test ' + r.name, kind: 'mark' }] });
  },
  // a Route Tracker clock-out for one driver: time until their "Week: …h" line changes
  async actual(name, iso, hours) {
    await H.until(() => H.ready() && !H.saving());
    const cur = JAJB.__mock.get('actual/' + __seed.week) || { week: __seed.week, drivers: {} };
    const t = name.toLowerCase().split(/\s+/); const id = 't-' + t.join('-');
    cur.drivers[id] = { name, keys: [t[0] + '|' + t[t.length - 1]], tid: id, days: { ...((cur.drivers[id] || {}).days || {}), [iso]: hours } };
    H.mark(); const t0 = performance.now(); const r0 = H.row(name).querySelector('.lv-sub').textContent;
    JAJB.__mock.set('actual/' + __seed.week, cur);
    await H.until(() => H.row(name).querySelector('.lv-sub').textContent !== r0, 20000);
    const shown = Math.round(performance.now() - t0);
    await H.until(() => H.ready());
    return { shown, calls: H.diff() };
  },
  // after a reload: the seed in memory (H.seed() writes it to the mock's storage)
  async load() { window.__seed = await fetch('/__fixtures/live-seed.json').then((r) => r.json()); return 'loaded'; },
  // the whole run: open, 3 remote saves, 3 own edits, a clock-out, a failed save, a conflict
  async scenario() {
    const out = {};
    await H.until(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Live schedule'));
    out.open = await H.openLive();
    out.remote = [];
    for (const i of [0, 1, 2]) { const r = await H.remote(i); out.remote.push({ paint: r.paint, ready: r.ready, reads: r.calls.scheduleWeekData || 0 }); }
    const skip = __seed.remotes.map((r) => r.name);
    out.edit = [];
    for (const day of ['Sat', 'Thu', 'Wed']) { const r = await H.edit(H.pick(day, skip), day); out.edit.push({ paint: r.paint, saved: r.saved }); }
    out.actual = await H.actual(H.pick('Mon'), '2026-10-05', 11.5);
    const cancel = () => [...document.querySelectorAll('.edit-modal button')].forEach((b) => { if (b.textContent.trim() === 'Cancel') b.click(); });
    const nf = H.pick('Tue'); const ef = await H.edit(nf, 'Tue', { fail: 'offline' });
    out.offline = { seen: ef.cellSeen.map((x) => x.at + ':' + x.t), after: H.cell(nf, 'Tue').textContent };
    cancel(); await H.sleep(50);
    const nc = H.pick('Mon'); const ec = await H.edit(nc, 'Mon', { conflict: 0 });
    await H.sleep(800);
    out.conflict = { seen: ec.cellSeen.map((x) => x.at + ':' + x.t), after: H.cell(nc, 'Mon').textContent,
      remoteShown: H.cell(__seed.remotes[0].name, __seed.remotes[0].day).textContent, rev: JAJB.__mock.get('weeks')[__seed.week].meta.rev };
    cancel();
    return out;
  },
  async seed() {
    const seed = await fetch('/__fixtures/live-seed.json').then((r) => r.json());
    const lm = await import('/app/live/live-model.js');
    window.__seed = seed;
    const meta = { week: seed.week, label: seed.label, num: seed.num, rev: 1, stats: lm.statsFromReport(seed.report), by: 'Jose (test)',
      at: new Date().toISOString(), publishedBy: 'Jose (test)', publishedAt: new Date().toISOString() };
    JAJB.__mock.reset();
    JAJB.__mock.set('weeks', { [seed.week]: { meta, summary: JSON.stringify(lm.summaryFromReport(seed.report, meta)), engine: seed.state } });
    return 'seeded';
  },
};
'harness ok';

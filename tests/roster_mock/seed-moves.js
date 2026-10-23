// TEST ONLY (Jose 2026-10-23). Run in the app's tab (http://localhost:8777, served by tests/live_mock/serve.py):
//   paste this whole file into that tab's DevTools console (http.server sends no CORS headers, so it
//   can't be fetched from the other port). Then open
//   http://localhost:8791/scheduling-legacy.html?frame=1&set=engine
// Writes the REAL engine week 2026-10-04 (tests/fixtures/live-seed.json, the way
// tests/live_mock/perf-harness.js H.seed() does; make it with python tests/live_mock/make_seed.py),
// so the moves window can run the rules engine and save, empties that week's change log, and lets the
// mock Amazon page (http://localhost:8791) talk to the app (localStorage['jajb-roster-test-origin']).
// Sat Oct 10 on it: 10:45 AM Alex Keller, Colin Drake, Casey Church (3 routes); 11:05 AM Grace Nolan (1).
// Remove the test-origin key when done.
(async () => {
  const seed = await fetch('/__fixtures/live-seed.json').then((r) => r.json());
  const lm = await import('/app/live/live-model.js');
  const at = new Date().toISOString();
  const meta = { week: seed.week, label: seed.label, num: seed.num, rev: 1, stats: lm.statsFromReport(seed.report),
    by: 'Jose (test)', at, publishedBy: 'Jose (test)', publishedAt: at };
  const all = JSON.parse(localStorage.getItem('jajbmock:weeks') || '{}');
  all[seed.week] = { meta, summary: JSON.stringify(lm.summaryFromReport(seed.report, meta)), engine: seed.state };
  localStorage.setItem('jajbmock:weeks', JSON.stringify(all));
  localStorage.removeItem('jajbmock:log/' + seed.week);
  localStorage.setItem('jajb-roster-test-origin', 'http://localhost:8791');
  return 'seeded the engine week ' + seed.week + ' + test origin';
})();

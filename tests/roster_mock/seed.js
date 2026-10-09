// TEST ONLY. Run in the app's tab (http://localhost:8777, served by tests/live_mock/serve.py):
//   paste this whole file into that tab's DevTools console (http.server sends no CORS headers,
//   so it can't be fetched from the other port)
// Writes a Live board week (2026-10-04, Week 41) into the mock JAJB's storage that matches
// tests/roster_mock/dispatch.html, and lets the mock Dispatch page (http://localhost:8791)
// receive the roster (localStorage['jajb-roster-test-origin']). Remove that key when done.
(() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = DAYS.map((day, i) => ({ day, date: `2026-10-${String(4 + i).padStart(2, '0')}`, open: day !== 'Sun', routes: 13 }));
  const d = (name, sat, tid = '') => ({ name, tid, cls: 'free', hours: 30, cells: { Sat: sat }, worked_dates: [] });
  const drivers = [
    d('Amy Early', '10:05 AM'), d('Bea Ready', '10:05 AM'), d('Carl Fox', '10:05 AM'),
    d('Nora Notlisted', '10:05 AM'), d('Dora Moss', '10:05 AM'),
    d('Barry Hughes', '10:25 AM'), d('Steven Heilmann', '10:25 AM'), d('Pat Quinn', '10:25 AM'),
    d('Tina Trainee', '10:25 AM (TRAIN drives w/ Cara Amos)'), d('Mike Rowe', '10:25 AM', 'T-MIKE'),
    d('Jose Nunez', '10:25 AM'), d('Hank Hours', '10:25 AM'), d('Sam Lee', '10:25 AM'),
    d('Zed Late', '11:05 AM'),
    d('Cara Amos', '10:25 AM (TRAIN helper w/ Tina Trainee)'), d('Ben Backup', '10:05 AM Backup'), d('Dan Disp', 'Dispatch'),
  ];
  const summary = { v: 1, week: '2026-10-04', label: 'Week-41 (Oct 4 - Oct 10, 2026)', num: 41, days, drivers,
    limits: { max_7day_hours: 60 }, marks: [], infeasible: [], errors: [], overridden: [] };
  const all = JSON.parse(localStorage.getItem('jajbmock:weeks') || '{}');
  const at = new Date().toISOString();
  all['2026-10-04'] = { meta: { week: '2026-10-04', label: summary.label, num: 41, rev: 1, stats: {}, by: 'test', at, publishedBy: 'test', publishedAt: at },
    summary: JSON.stringify(summary), engine: '' };
  localStorage.setItem('jajbmock:weeks', JSON.stringify(all));
  localStorage.setItem('jajb-roster-test-origin', 'http://localhost:8791');
  return 'seeded week 2026-10-04 + test origin';
})();

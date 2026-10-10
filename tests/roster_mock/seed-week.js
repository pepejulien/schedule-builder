// TEST ONLY. Paste into the app's tab (http://localhost:8777, tests/live_mock/serve.py) DevTools console.
// Writes a Live board week (2026-10-11, Week 42) matching tests/roster_mock/scheduling.html and lets
// the mock page (http://localhost:8791) receive it (localStorage['jajb-roster-test-origin']).
// Expected on the mock page: 9 to fill (Cara Sun route + Mon backup, Barry Tue Helper 10:25, Tina Tue
// Driver 10:25, Dan Thu Dispatcher + Sat Meeting, José Wed Driver 11:25, Sam Lee Fri Driver 10:45,
// Kim Mon Driver 10:05); Kim Sun already there; Una Mon busy ("Unavailable"); Zed Thu no 2:00 PM
// shift; Nora not on the page; Bea has nothing to send.
(() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = DAYS.map((day, i) => ({ day, date: `2026-10-${11 + i}`, open: true, routes: 13 }));
  const d = (name, cells, tid = '') => ({ name, tid, cls: 'free', hours: 30, cells, worked_dates: [] });
  const drivers = [
    d('Cara Amos', { Sun: '10:05 AM', Mon: '10:25 AM Backup' }),
    d('Barry Hughes', { Tue: '10:25 AM (TRAIN helper w/ Tina Trainee)' }),
    d('Tina Trainee', { Tue: '10:25 AM (TRAIN drives w/ Barry Hughes)' }),
    d('Dan Disp', { Thu: 'Dispatch', Sat: '9:00 AM Meeting' }),
    d('Una Off', { Mon: '10:05 AM' }),
    d('Jose Nunez', { Wed: '11:25 AM' }),
    d('Kim Already', { Sun: '10:05 AM', Mon: '10:05 AM' }),
    d('Zed Late', { Thu: '2:00 PM' }),
    d('Sam Lee', { Fri: '10:45 AM' }),
    d('Nora Notlisted', { Sun: '10:05 AM' }),
    d('Bea Blank', { Sun: 'Unavailable', Mon: 'Called out' }),
  ];
  const summary = { v: 1, week: '2026-10-11', label: 'Week-42 (Oct 11 - Oct 17, 2026)', num: 42, days, drivers,
    limits: { max_7day_hours: 60 }, marks: [], infeasible: [], errors: [], overridden: [] };
  const all = JSON.parse(localStorage.getItem('jajbmock:weeks') || '{}');
  const at = new Date().toISOString();
  all['2026-10-11'] = { meta: { week: '2026-10-11', label: summary.label, num: 42, rev: 1, stats: {}, by: 'test', at, publishedBy: 'test', publishedAt: at },
    summary: JSON.stringify(summary), engine: '' };
  localStorage.setItem('jajbmock:weeks', JSON.stringify(all));
  localStorage.setItem('jajb-roster-test-origin', 'http://localhost:8791');
  return 'seeded week 2026-10-11 + test origin';
})();

// TEST ONLY. Paste into the app's tab (http://localhost:8777, tests/live_mock/serve.py) DevTools console.
// Writes a Live board week matching tests/roster_mock/scheduling.html and lets the mock page
// (http://localhost:8791) receive it (localStorage['jajb-roster-test-origin']).
// The week is NEXT week (its Sunday), the same rule as scheduling.html — so no day is "already over".
// For another week set WEEK = 'YYYY-MM-DD' (a Sunday) and open scheduling.html?date=<that Sunday>.
// Expected on the mock page: 12 to put in + Lou's Tue backup to tick, then 4 "Set as backup" ticks
// (Cara Mon, Lou Tue, Bo Wed, Bo Sat). Put in: Cara Sun route + Mon backup, Barry Tue Helper 10:25,
// Tina Tue Driver 10:25, Dan Thu Dispatcher + Sat Meeting, José Wed Driver 11:25, Kim Mon Driver 10:05,
// Sam Lee Fri Driver 10:45, Bo Wed backup + Thu route + Sat backup (the last shift put in is a backup).
// Kim Sun already there; Una Mon busy ("Unavailable"); Zed Thu no 2:00 PM shift; Nora not on the page;
// Bea has nothing to send. With scheduling.html?empty=1: 15 to put in (+ Una Mon, Kim Sun, Lou Tue) and
// the same 4 ticks.
(() => {
  const WEEK = null;                                       // or 'YYYY-MM-DD' (a Sunday)
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const sun = WEEK ? new Date(WEEK + 'T12:00:00') : new Date();
  sun.setHours(12, 0, 0, 0);
  if (!WEEK) sun.setDate(sun.getDate() - sun.getDay() + 7);
  const at = (i) => { const d = new Date(sun); d.setDate(sun.getDate() + i); return d; };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const md = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const jan1 = new Date(sun.getFullYear(), 0, 1, 12);
  const num = Math.floor((Math.round((sun - jan1) / 864e5) + jan1.getDay()) / 7) + 1;
  const week = iso(sun);
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = DAYS.map((day, i) => ({ day, date: iso(at(i)), open: true, routes: 13 }));
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
    d('Lou Backup', { Tue: '10:05 AM Backup' }),
    d('Bo Backup', { Wed: '10:45 AM Backup', Thu: '10:05 AM', Sat: '11:05 AM Backup' }),
  ];
  const label = `Week-${num} (${md(sun)} - ${md(at(6))}, ${at(6).getFullYear()})`;
  const summary = { v: 1, week, label, num, days, drivers,
    limits: { max_7day_hours: 60 }, marks: [], infeasible: [], errors: [], overridden: [] };
  const all = JSON.parse(localStorage.getItem('jajbmock:weeks') || '{}');
  const now = new Date().toISOString();
  all[week] = { meta: { week, label, num, rev: 1, stats: {}, by: 'test', at: now, publishedBy: 'test', publishedAt: now },
    summary: JSON.stringify(summary), engine: '' };
  localStorage.setItem('jajbmock:weeks', JSON.stringify(all));
  localStorage.setItem('jajb-roster-test-origin', 'http://localhost:8791');
  return `seeded week ${week} (${label}) + test origin`;
})();

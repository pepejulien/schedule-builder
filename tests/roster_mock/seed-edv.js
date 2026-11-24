// TEST ONLY (Jose 2026-11-24). Paste into the app's tab (http://localhost:8777) DevTools console, then open
// http://localhost:8791/scheduling-legacy.html?frame=1&set=edv and press "Run the bookmark (test)".
// Live board week 2026-10-04, Sat Oct 10 (schedule time + 20 min = Amazon's): the EDV drivers list
// (assigner/edv) = Alex Keller, Chris Smith, Mark Barker; certifications (dispatch/lists.driverInfo):
// Alex, Chris, Eva, Ed EDV - Mark only CDV.
// Expected, first click: EDV service filled first - Alex (10:45), Chris moved from 10:25 to 10:45,
// Mark "on the list but not EDV-certified", 1 EDV row left -> pick list Eva Cert / Ed Volt. Tick one,
// Fill 3 rows. Save the EDV rows (mock Save), click again: Standard Parcel gets the other 5.
(() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = DAYS.map((day, i) => ({ day, date: `2026-10-${String(4 + i).padStart(2, '0')}`, open: day !== 'Sun', routes: 9 }));
  const d = (name, sat, tid = '') => ({ name, tid, cls: 'free', hours: 30, cells: { Sat: sat }, worked_dates: [] });
  const drivers = [
    d('Alex Keller', '10:25 AM', 'A-ALEX'), d('Chris Smith', '10:05 AM', 'A-CHRIS'), d('Mark Barker', '10:25 AM', 'A-MARK'),
    d('Eva Cert', '10:05 AM', 'A-EVA'), d('Ed Volt', '10:25 AM', 'A-ED'),
    d('Ron Reg', '10:05 AM', 'A-RON'), d('Rita Reg', '10:05 AM', 'A-RITA'), d('Rob Reg', '10:25 AM', 'A-ROB'),
    d('Ben Backup', '10:05 AM Backup'),
  ];
  const summary = { v: 1, week: '2026-10-04', label: 'Week-41 (Oct 4 - Oct 10, 2026)', num: 41, days, drivers,
    limits: { max_7day_hours: 60 }, marks: [], infeasible: [], errors: [], overridden: [] };
  const all = JSON.parse(localStorage.getItem('jajbmock:weeks') || '{}');
  const at = new Date().toISOString();
  all['2026-10-04'] = { meta: { week: '2026-10-04', label: summary.label, num: 41, rev: 1, stats: {}, by: 'test', at, publishedBy: 'test', publishedAt: at },
    summary: JSON.stringify(summary), engine: '' };
  localStorage.setItem('jajbmock:weeks', JSON.stringify(all));
  localStorage.setItem('jajbmock:assigner/edv', JSON.stringify({ names: ['Alex Keller', 'Chris Smith', 'Mark Barker'], by: 'test' }));
  const info = { 'Alex Keller': { tid: 'A-ALEX', cert: 'EDV' }, 'Chris Smith': { tid: 'A-CHRIS', cert: 'EDV' },
    'Mark Barker': { tid: 'A-MARK', cert: 'CDV' }, 'Eva Cert': { tid: 'A-EVA', cert: 'EDV' }, 'Ed Volt': { tid: 'A-ED', cert: 'EDV' },
    'Ron Reg': { tid: 'A-RON', cert: '' }, 'Rita Reg': { tid: 'A-RITA', cert: 'CDV' }, 'Rob Reg': { tid: 'A-ROB', cert: '' } };
  localStorage.setItem('jajbmock:dispatch/lists', JSON.stringify({ drivers: Object.keys(info), driverInfo: info }));
  localStorage.setItem('jajb-roster-test-origin', 'http://localhost:8791');
  return 'seeded EDV week 2026-10-04 + test origin';
})();

// Driver preferences + requested days off (2026-10-09): public/app/lib/driver-prefs.js.
//   node tests/driver_prefs_test.mjs
// The storage helpers run against a tiny in-memory window.JAJB (the Firebase path of api.js).
import {
  PREFS_KEY, WHY_LABEL, normPref, weekendOn, prefOffDays, onWeekendDays, weekUnavailable, prefSummary,
  loadDriverPrefs, saveDriverPref, loadDriverRoster,
} from '../public/app/lib/driver-prefs.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

eq('key', PREFS_KEY, 'standing/drivers.json');
eq('labels', WHY_LABEL, { timeoff: 'Asked off', days: "Can't work", weekend: 'Off weekend' });

// normPref
eq('null in', normPref(null), null);
eq('array in', normPref([]), null);
eq('empty obj', normPref({}), null);
eq('by/at alone', normPref({ by: 'Jose', at: '2026-10-09T00:00:00Z' }), null);
eq('all 7 days dropped', normPref({ days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }), null);
eq('empty days dropped', normPref({ days: [] }), null);
eq('days sorted + deduped + bad dropped', normPref({ days: ['Fri', 'mon', 'Mon', 'Funday', 'Sun'] }), { days: ['Sun', 'Mon', 'Fri'] });
eq('clamp maxDays hi', normPref({ maxDays: 9 }), { maxDays: 6 });
eq('clamp maxDays lo', normPref({ maxDays: 0 }), { maxDays: 1 });
eq('maxDays string ok', normPref({ maxDays: '4' }), { maxDays: 4 });
eq('maxDays junk dropped', normPref({ maxDays: 'x', maxRow: null }), null);
eq('maxDays bool dropped', normPref({ maxDays: true }), null);
eq('clamp maxRow', normPref({ maxRow: 8 }), { maxRow: 5 });
eq('together false dropped', normPref({ together: false }), null);
eq('together kept', normPref({ together: true }), { together: true });
eq('weekend bad mode', normPref({ weekends: { mode: 'never', on: '2026-10-17' } }), null);
eq('weekend bad date', normPref({ weekends: { mode: 'alternate', on: '10/17/2026' } }), null);
eq('weekend kept', normPref({ weekends: { mode: 'alternate', on: '2026-10-17' } }), { weekends: { mode: 'alternate', on: '2026-10-17' } });
eq('weekend Sun snaps to Sat before', normPref({ weekends: { mode: 'alternate', on: '2026-10-18' } }).weekends.on, '2026-10-17');
eq('weekend Wed snaps to its Sat', normPref({ weekends: { mode: 'alternate', on: '2026-10-14' } }).weekends.on, '2026-10-17');
eq('note trimmed', normPref({ note: '  school  ' }), { note: 'school' });
eq('blank note dropped', normPref({ note: '   ' }), null);
eq('by/at kept with content', normPref({ maxDays: 3, by: 'J', at: 'T' }), { maxDays: 3, by: 'J', at: 'T' });

// weekendOn — alternates both ways from `on`
const alt = { weekends: { mode: 'alternate', on: '2026-10-17' } };
eq('on itself', weekendOn(alt, '2026-10-17'), true);
eq('+1 week off', weekendOn(alt, '2026-10-24'), false);
eq('+2 weeks on', weekendOn(alt, '2026-10-31'), true);
eq('-1 week off', weekendOn(alt, '2026-10-10'), false);
eq('-2 weeks on', weekendOn(alt, '2026-10-03'), true);
eq('-3 weeks off', weekendOn(alt, '2026-09-26'), false);
eq('across DST (+4 wks, Nov 14)', weekendOn(alt, '2026-11-14'), true);
eq('no rule', weekendOn({ maxDays: 3 }, '2026-10-17'), null);
eq('null pref', weekendOn(null, '2026-10-17'), null);

// prefOffDays / onWeekendDays across the week boundary
eq('wk 10-18: Sun ON, Sat 10-24 OFF', prefOffDays(alt, '2026-10-18'), { Sat: 'weekend' });
eq('wk 10-11: Sun 10-11 (wknd of 10-10) OFF, Sat 10-17 ON', prefOffDays(alt, '2026-10-11'), { Sun: 'weekend' });
eq('on days wk 10-18', onWeekendDays(alt, '2026-10-18'), ['Sun']);
eq('on days wk 10-11', onWeekendDays(alt, '2026-10-11'), ['Sat']);
eq('on days no rule', onWeekendDays({ maxDays: 2 }, '2026-10-11'), []);
eq('days rule', prefOffDays({ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] }, '2026-10-11'), { Sun: 'days', Sat: 'days' });
eq('days wins over weekend', prefOffDays({ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], weekends: alt.weekends }, '2026-10-18'),
  { Sun: 'days', Sat: 'days' });
eq('mixed', prefOffDays({ days: ['Sun', 'Mon', 'Tue', 'Sat'], weekends: alt.weekends }, '2026-10-18'),
  { Wed: 'days', Thu: 'days', Fri: 'days', Sat: 'weekend' });
eq('no pref', prefOffDays(null, '2026-10-18'), {});

// weekUnavailable
const doc = { v: 1, drivers: {
  'Cara Amos': { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  'Colin Drake': { weekends: alt.weekends },
  'Dee Free': { maxDays: 4 },
} };
const timeoff = {
  '2026-10-19|Dee Free': { name: 'Dee Free', day: '2026-10-19', note: 'dentist' },
  '2026-10-24|Colin Drake': { name: 'Colin Drake', day: '2026-10-24', note: '' },
  '2026-10-18|cara amos': { name: 'cara amos', day: '2026-10-18', note: ' wedding ' },
  '2026-10-25|Dee Free': { name: 'Dee Free', day: '2026-10-25', note: 'next week' },
  '2026-10-17|Dee Free': { name: 'Dee Free', day: '2026-10-17', note: 'last week' },
};
eq('weekUnavailable', weekUnavailable(doc, timeoff, '2026-10-18'), {
  'Cara Amos': { Sun: { why: 'timeoff', note: 'wedding' }, Sat: { why: 'days' } },
  'Colin Drake': { Sat: { why: 'timeoff' } },
  'Dee Free': { Mon: { why: 'timeoff', note: 'dentist' } },
});
eq('weekUnavailable empty', weekUnavailable(null, null, '2026-10-18'), {});
eq('weekUnavailable timeoff only', weekUnavailable({}, { a: { name: 'New Guy', day: '2026-10-20', note: '' } }, '2026-10-18'),
  { 'New Guy': { Tue: { why: 'timeoff' } } });

// prefSummary
eq('sum Mon-Fri', prefSummary({ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] }), ['Mon–Fri only']);
eq('sum no Sun Sat? (not a run)', prefSummary({ days: ['Sun', 'Tue', 'Wed', 'Thu', 'Fri'] }), ['No Mon, Sat']);
eq('sum one missing', prefSummary({ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }), ['No Sun']);
eq('sum few days', prefSummary({ days: ['Mon', 'Thu'] }), ['Mon, Thu only']);
eq('sum one day', prefSummary({ days: ['Sat'] }), ['Sat only']);
eq('sum all', prefSummary({ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], maxDays: 4, maxRow: 2, together: true, weekends: alt.weekends }),
  ['Mon–Fri only', '4 days max', '2 in a row max', 'Days together', 'Every other weekend']);
eq('sum 1 day max', prefSummary({ maxDays: 1 }), ['1 day max']);
eq('sum null', prefSummary(null), []);

// storage, against an in-memory window.JAJB
const store = {};
let weeksCalls = 0;
globalThis.window = { JAJB: {
  me: () => ({ name: 'Jose (test)' }), user: () => ({ email: 'j@x' }),
  scheduleGet: async (n) => store[n] || null,
  schedulePut: async (n, f) => { store[n] = { ...f, by: 'Jose (test)', at: 'now' }; },
  saveScheduleWeek: async () => {},
  scheduleWeeks: async () => { weeksCalls++; return [{ week: '2026-10-18' }, { week: '2026-10-11' }]; },
  scheduleWeekData: async (w) => (w === '2026-10-18' ? null
    : { meta: {}, summary: JSON.stringify({ drivers: [{ name: 'Zed Last', cls: 'gold' }, { name: 'cara amos', cls: 'free' }] }), engine: '{}' }),
} };
eq('load missing', await loadDriverPrefs(), { v: 1, drivers: {} });
store.drivers = { json: '{not json' };
eq('load corrupt', await loadDriverPrefs(), { v: 1, drivers: {} });
delete store.drivers;
let d1 = await saveDriverPref('Cara Amos', { maxDays: 9, together: false, by: 'spoof' });
eq('save clamps + signs', { maxDays: d1.drivers['Cara Amos'].maxDays, by: d1.drivers['Cara Amos'].by, together: d1.drivers['Cara Amos'].together },
  { maxDays: 6, by: 'Jose (test)', together: undefined });
ok('save at is ISO', /^\d{4}-\d{2}-\d{2}T/.test(d1.drivers['Cara Amos'].at), d1.drivers['Cara Amos'].at);
// another dispatcher saved someone else meanwhile: the re-read keeps them
const other = JSON.parse(store.drivers.json); other.drivers['Colin Drake'] = { maxRow: 2 }; store.drivers.json = JSON.stringify(other);
d1 = await saveDriverPref('Dee Free', { days: ['Mon'] });
eq('save keeps others', Object.keys(d1.drivers).sort(), ['Cara Amos', 'Colin Drake', 'Dee Free']);
d1 = await saveDriverPref('cara AMOS', { maxRow: 3 });
eq('save replaces case-insensitively', Object.keys(d1.drivers).sort(), ['Colin Drake', 'Dee Free', 'cara AMOS']);
d1 = await saveDriverPref('Dee Free', { together: false });
eq('save empty removes', Object.keys(d1.drivers).sort(), ['Colin Drake', 'cara AMOS']);
eq('load round-trip', Object.keys((await loadDriverPrefs()).drivers).sort(), ['Colin Drake', 'cara AMOS']);
const roster = await loadDriverRoster();
eq('roster (week fallback, merge, dedupe, sort)', roster,
  [{ name: 'cara amos', tier: 'free' }, { name: 'Colin Drake', tier: null }, { name: 'Zed Last', tier: 'gold' }]);
ok('roster read the weeks once', weeksCalls === 1, String(weeksCalls));
store.drivers = null;
let threw = false;
window.JAJB.scheduleGet = async () => { throw new Error('offline'); };
try { await saveDriverPref('X', { maxDays: 2 }); } catch { threw = true; }
ok('save does not write over on a failed read', threw && store.drivers === null);

console.log(`driver_prefs: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

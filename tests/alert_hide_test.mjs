// The Live board's Hide button on the Route Tracker alert cards (public/app/live/alert-hide.js):
// row keys, "a new row brings the card back", and the per-login, per-week store.   node tests/alert_hide_test.mjs
import { workedKeys, rtKeys, stillHidden, pruneHidden, loadHidden, saveHidden } from '../public/app/live/alert-hide.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

const mem = {};
globalThis.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };

const missing = [
  { name: 'Braden Cole Green', date: '2026-11-22', answer: 'worked', auto: true },
  { name: 'Ana Diaz', date: '2026-11-23', answer: null },            // an open question: not this card's
  { name: 'Bo Lee', date: '2026-11-21', answer: 'worked' },
  { name: 'Bo Lee', date: '2026-11-21', answer: 'worked' },
];
const rows = [
  { name: 'Cara Amos', date: '2026-11-22', kind: 'nosched', rt: 'route' },
  { name: 'Di Fox', date: '2026-11-23', kind: 'off', rt: 'backup' },
];

// --- keys: the "worked" rows only, sorted, no repeats
eq('worked keys', workedKeys(missing), ['Bo Lee|2026-11-21|worked', 'Braden Cole Green|2026-11-22|worked']);
eq('rt keys', rtKeys(rows), ['Cara Amos|2026-11-22|nosched|route', 'Di Fox|2026-11-23|off|backup']);
eq('no rows', [workedKeys(null), rtKeys(undefined)], [[], []]);

// --- still hidden: rows going away keep it hidden, a new row brings it back
const saved = rtKeys(rows);
ok('same rows: hidden', stillHidden(saved, rtKeys(rows)));
ok('a row fixed: still hidden', stillHidden(saved, rtKeys(rows.slice(1))));
ok('no rows left: still hidden', stillHidden(saved, []));
ok('a new row: shows again', !stillHidden(saved, rtKeys([...rows, { name: 'Ed Ray', date: '2026-11-24', kind: 'mark', rt: 'route' }])));
ok('same driver, other issue: shows again', !stillHidden(saved, rtKeys([{ ...rows[0], kind: 'off' }])));
ok('never hidden', !stillHidden(undefined, []));

const keys = { worked: workedKeys(missing), rt: rtKeys(rows) };
eq('prune: both stay', pruneHidden({ worked: keys.worked, rt: keys.rt }, keys), { worked: keys.worked, rt: keys.rt });
eq('prune: a new worked row drops that card only', pruneHidden({ worked: keys.worked.slice(1), rt: keys.rt }, keys), { rt: keys.rt });
eq('prune: nothing hidden', pruneHidden({}, keys), {});

// --- the store: per login, per week
saveHidden('jose', '2026-11-22', { worked: keys.worked, rt: keys.rt });
eq('reload keeps it', loadHidden('jose', '2026-11-22'), { worked: keys.worked, rt: keys.rt });
eq('another login: nothing hidden', loadHidden('misty', '2026-11-22'), {});
eq('another week: nothing hidden', loadHidden('jose', '2026-11-15'), {});
saveHidden('misty', '2026-11-22', { rt: keys.rt });
eq('Misty hides one, Jose keeps both', [loadHidden('misty', '2026-11-22'), loadHidden('jose', '2026-11-22')],
  [{ rt: keys.rt }, { worked: keys.worked, rt: keys.rt }]);
saveHidden('jose', '2026-11-22', {});
eq('Show hidden clears it', loadHidden('jose', '2026-11-22'), {});
eq('no login: never stored', [saveHidden('', '2026-11-22', { rt: ['x'] }), loadHidden('', '2026-11-22')], [undefined, {}]);
for (let i = 0; i < 9; i++) saveHidden('jose', `2026-10-0${i + 1}`, { rt: ['x'] });
ok('old weeks drop off', Object.keys(JSON.parse(mem['sb-live-hidden-alerts:jose'])).length === 6);
mem['sb-live-hidden-alerts:bad'] = '{not json';
eq('a broken store reads as nothing hidden', loadHidden('bad', '2026-11-22'), {});

console.log(`${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

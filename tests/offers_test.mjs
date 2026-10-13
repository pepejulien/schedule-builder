// VET / VTO offers card helpers (public/app/live/offers-model.js): the fields sent to the hub's
// saveScheduleOffer, the row labels, the take status words.   node tests/offers_test.mjs
import {
  TIERS, defaultForm, dayLabel, timeLabel, offerDays, offerWaves, buildOfferFields, offerWhat, offerLabel,
  offerStatusWord, shownOffers, takeStatus, whyText, dayOffers, stripHead, offerCounts, countsLabel, stripStatus,
} from '../public/app/live/offers-model.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) pass++; else { fail++; fails.push(`${name} — ${detail || ''}`); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// the hub rules' key whitelist for schedule_offers (SPEC-v2 §8): nothing the card sends may fall outside it
const ALLOWED = new Set(['v', 'kind', 'week', 'date', 'day', 'role', 'wave', 'slots', 'status', 'taken', 'audience', 'mode',
  'windowHours', 'decideAt', 'priority', 'note', 'by', 'at']);
const form = (p) => ({ ...defaultForm(), date: '2026-10-17', ...p });

// --- labels
eq('tiers', TIERS, ['Top performer', 'Solid', 'Fair', 'Underperforming', 'Termination review']);
eq('dayLabel', dayLabel('2026-10-17'), 'Sat Oct 17');
eq('dayLabel Thu', dayLabel('2026-10-15'), 'Thu Oct 15');
eq('timeLabel on the hour', timeLabel(new Date(2026, 9, 13, 18, 0).getTime()), 'Tue 6 PM');
eq('timeLabel minutes', timeLabel(new Date(2026, 9, 12, 14, 7).getTime()), 'Mon 2:07 PM');
eq('timeLabel noon / midnight', [timeLabel(new Date(2026, 9, 12, 12, 0).getTime()), timeLabel(new Date(2026, 9, 12, 0, 30).getTime())],
  ['Mon 12 PM', 'Mon 12:30 AM']);
eq('timeLabel none', timeLabel(0), '');

// --- days and waves
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => ({
  day, date: `2026-10-${String(11 + i).padStart(2, '0')}`, open: day !== 'Wed',
  waves: day === 'Sat' ? { '11:05 AM': 3, '10:45 AM': 12, '1:05 PM': 1, '10:25 AM': 0 } : {} }));
eq('offerDays: today on, open only', offerDays(days, '2026-10-13').map((x) => x.date),
  ['2026-10-13', '2026-10-15', '2026-10-16', '2026-10-17']);
eq('offerDays label', offerDays(days, '2026-10-17'), [{ day: 'Sat', date: '2026-10-17', label: 'Sat Oct 17' }]);
eq('offerDays past week', offerDays(days, '2026-10-20'), []);
eq('offerWaves sorted, empty waves out', offerWaves(days[6]), ['10:45 AM', '11:05 AM', '1:05 PM']);
eq('offerWaves none', [offerWaves(days[1]), offerWaves(undefined)], [[], []]);

// --- fields from the form
eq('default VET, everyone, fcfs', buildOfferFields(form({ wave: '10:45 AM' })), { fields: {
  kind: 'vet', date: '2026-10-17', wave: '10:45 AM', slots: 1, role: 'road',
  audience: { tiers: [], maxWeekHours: null }, mode: 'fcfs' } });
eq('VET backup any wave, 3 spots', buildOfferFields(form({ role: 'backup', slots: '3' })).fields,
  { kind: 'vet', date: '2026-10-17', wave: '', slots: 3, role: 'backup', audience: { tiers: [], maxWeekHours: null }, mode: 'fcfs' });
eq('VTO: no role, no wave', buildOfferFields(form({ kind: 'vto', role: 'backup', wave: '10:45 AM' })).fields,
  { kind: 'vto', date: '2026-10-17', wave: '', slots: 1, audience: { tiers: [], maxWeekHours: null }, mode: 'fcfs' });
eq('groups: tiers in the fixed order, hours', buildOfferFields(form({ sendTo: 'groups', tiers: ['Fair', 'Top performer', 'Bogus'],
  under: true, underHours: '35' })).fields.audience, { tiers: ['Top performer', 'Fair'], maxWeekHours: 35 });
eq('groups: hours only', buildOfferFields(form({ sendTo: 'groups', under: true })).fields.audience, { tiers: [], maxWeekHours: 40 });
eq('groups: tiers only (hours box ignored when unticked)', buildOfferFields(form({ sendTo: 'groups', tiers: ['Solid'], underHours: 'x' })).fields.audience,
  { tiers: ['Solid'], maxWeekHours: null });
eq('groups: nothing picked', buildOfferFields(form({ sendTo: 'groups' })), { error: 'Pick at least one group, or send to everyone.' });
eq('Everyone ignores ticked groups', buildOfferFields(form({ tiers: ['Fair'], under: true })).fields.audience, { tiers: [], maxWeekHours: null });
const win = buildOfferFields(form({ mode: 'window', windowHours: '12', prTiers: ['Solid', 'Top performer'], prHours: '38', note: '  for Sat  ' })).fields;
eq('window mode', [win.mode, win.windowHours, win.priority, win.note],
  ['window', 12, { tiers: ['Top performer', 'Solid'], maxWeekHours: 38 }, 'for Sat']);
eq('window defaults (24 h, Top performer under 40)', [buildOfferFields(form({ mode: 'window' })).fields.windowHours,
  buildOfferFields(form({ mode: 'window' })).fields.priority], [24, { tiers: ['Top performer'], maxWeekHours: 40 }]);
eq('window: no tiers approved right away', buildOfferFields(form({ mode: 'window', prTiers: [] })).fields.priority, { tiers: [], maxWeekHours: 40 });
ok('fcfs sends no window fields', !('windowHours' in buildOfferFields(form({ windowHours: '5' })).fields)
  && !('priority' in buildOfferFields(form({})).fields));
ok('no note key when empty', !('note' in buildOfferFields(form({ note: '   ' })).fields));
eq('note capped at 300', buildOfferFields(form({ note: 'x'.repeat(400) })).fields.note.length, 300);
for (const [k, v] of [['no day', { date: '' }], ['0 spots', { slots: '0' }], ['51 spots', { slots: '51' }], ['1.5 spots', { slots: '1.5' }],
  ['blank spots', { slots: '' }], ['bad kind', { kind: 'x' }], ['wait 0', { mode: 'window', windowHours: '0' }],
  ['wait 169', { mode: 'window', windowHours: '169' }], ['priority hours blank', { mode: 'window', prHours: '' }],
  ['under hours 0', { sendTo: 'groups', under: true, underHours: '0' }]]) {
  ok('error: ' + k, !!buildOfferFields(form(v)).error, JSON.stringify(buildOfferFields(form(v))));
}
eq('spots 50 ok', buildOfferFields(form({ slots: '50' })).fields.slots, 50);
for (const p of [{}, { kind: 'vto' }, { mode: 'window', sendTo: 'groups', tiers: ['Fair'], under: true, note: 'n' }]) {
  const keys = Object.keys(buildOfferFields(form(p)).fields);
  ok('keys in the rules whitelist ' + JSON.stringify(p), keys.every((k) => ALLOWED.has(k)), keys.join(','));
}

// --- offer rows
const vet = { id: 'a', kind: 'vet', date: '2026-10-17', week: '2026-10-11', role: 'road', wave: '10:45 AM', slots: 3, taken: 1, status: 'open' };
eq('offerLabel VET', offerLabel(vet), 'VET · Sat Oct 17 · 10:45 AM route · 1 of 3 taken');
eq('offerLabel VET backup any wave', offerLabel({ ...vet, role: 'backup', wave: '', taken: 0 }), 'VET · Sat Oct 17 · backup, any wave · 0 of 3 taken');
eq('offerLabel VTO', offerLabel({ kind: 'vto', date: '2026-10-15', wave: '', slots: 2, taken: 2 }), 'VTO · Thu Oct 15 · day off · 2 of 2 taken');
eq('offerWhat no taken field', offerLabel({ kind: 'vet', date: '2026-10-17', role: 'road', wave: '', slots: 1 }), 'VET · Sat Oct 17 · route, any wave · 0 of 1 taken');
eq('offerWhat', offerWhat({ kind: 'vet', role: 'backup', wave: '11:05 AM' }), '11:05 AM backup');
eq('status words', ['open', 'filled', 'closed', undefined].map((s) => offerStatusWord({ status: s })), ['Open', 'Filled', 'Closed', 'Open']);
const rows = [{ id: 'old', week: '2026-10-04', date: '2026-10-09' }, { id: 'this', week: '2026-10-11', date: '2026-10-12' },
  { id: 'next', week: '2026-10-18', date: '2026-10-20' }];
eq('shownOffers: this week and later', shownOffers(rows, '2026-10-14').map((o) => o.id), ['this', 'next']);
eq('shownOffers on a Sunday', shownOffers(rows, '2026-10-11').map((o) => o.id), ['this', 'next']);
eq('shownOffers null', shownOffers(null, '2026-10-14'), []);

// --- take status words
const decideAt = new Date(2026, 9, 13, 18, 0).getTime();
const W = { ...vet, mode: 'window', decideAt };
eq('approved', takeStatus({ status: 'approved' }, vet), { text: 'Approved', ask: false });
eq('applied', takeStatus({ status: 'applied' }, vet), { text: 'On the board', ask: false });
eq('waiting', takeStatus({ status: 'waiting' }, W), { text: 'Waiting until Tue 6 PM', ask: false });
eq('waiting, no decideAt', takeStatus({ status: 'waiting' }, vet).text, 'Waiting');
eq('refused known why', takeStatus({ status: 'refused', why: 'limits' }, vet).text, "Couldn't add — over the hour limits");
eq('refused free text', takeStatus({ status: 'refused', why: '7 days in a row' }, vet).text, "Couldn't add — 7 days in a row");
eq('refused no why', takeStatus({ status: 'refused' }, vet).text, "Couldn't add");
eq('declined', takeStatus({ status: 'declined' }, vet), { text: 'Declined', ask: false });
eq('counter on a route offer', takeStatus({ status: 'pending', counter: true, role: 'road' }, vet),
  { text: 'Asked for backup instead', ask: true });
eq('counter with its own role', takeStatus({ status: 'pending', counter: true, role: 'backup' }, vet),
  { text: 'Asked for backup instead', ask: true });
eq('counter on a backup offer', takeStatus({ status: 'pending', counter: true }, { ...vet, role: 'backup' }),
  { text: 'Asked for a route instead', ask: true });
eq('counter approved', takeStatus({ status: 'approved', counter: true }, vet).text, 'Approved — as a backup');
eq('counter applied', takeStatus({ status: 'applied', counter: true, role: 'road' }, { ...vet, role: 'backup' }).text, 'On the board — as a route');
eq('pending, not a counter', takeStatus({ status: 'pending' }, vet), { text: 'Pending', ask: false });
eq('whyText empty', whyText(''), '');

// --- the day strip
const dayRows = [
  { id: 'vto', kind: 'vto', date: '2026-10-13', slots: 2, at: 1 },
  { id: 'any', kind: 'vet', role: 'backup', wave: '', date: '2026-10-13', slots: 1, at: 2 },
  { id: 'late', kind: 'vet', role: 'road', wave: '11:25 AM', date: '2026-10-13', slots: 1, at: 3 },
  { id: 'early', kind: 'vet', role: 'road', wave: '10:45 AM', date: '2026-10-13', slots: 3, at: 4 },
  { id: 'other', kind: 'vet', role: 'road', wave: '10:45 AM', date: '2026-10-14', slots: 1, at: 5 }];
eq('dayOffers: that day, VET by wave, any wave last, VTO after', dayOffers(dayRows, '2026-10-13').map((o) => o.id), ['early', 'late', 'any', 'vto']);
eq('dayOffers none', dayOffers(dayRows, '2026-10-15'), []);
eq('dayOffers null', dayOffers(null, '2026-10-13'), []);
eq('stripHead route', stripHead(dayRows[3]), 'VET · 10:45 AM route');
eq('stripHead backup any wave', stripHead(dayRows[1]), 'VET · backup, any wave');
eq('stripHead VTO', stripHead(dayRows[0]), 'VTO · day off');
const tk = [{ status: 'approved' }, { status: 'applied' }, { status: 'waiting' }, { status: 'pending', counter: true },
  { status: 'pending' }, { status: 'refused' }, { status: 'declined' }];
eq('offerCounts', offerCounts({ slots: 3 }, tk), { offered: 3, taken: 2, waiting: 2 });
eq('offerCounts before the takes are read', offerCounts({ slots: 3, taken: 1 }, undefined), { offered: 3, taken: 1, waiting: 0 });
eq('offerCounts no takes', offerCounts({ slots: 2 }, []), { offered: 2, taken: 0, waiting: 0 });
eq('countsLabel', countsLabel({ offered: 3, taken: 1, waiting: 1 }), '3 offered · 1 taken · 1 waiting');
eq('countsLabel no waiting', countsLabel({ offered: 3, taken: 1, waiting: 0 }), '3 offered · 1 taken');
eq('stripStatus open', stripStatus({ status: 'open' }, { offered: 3, taken: 1 }), { word: 'open', chip: 'green' });
eq('stripStatus filled', stripStatus({ status: 'filled' }, { offered: 3, taken: 3 }), { word: 'full', chip: 'gray' });
eq('stripStatus every spot taken', stripStatus({ status: 'open' }, { offered: 2, taken: 2 }).word, 'full');
eq('stripStatus closed', stripStatus({ status: 'closed' }, { offered: 2, taken: 2 }), { word: 'closed', chip: 'gray' });

console.log(`${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('FAIL ' + f); process.exit(1); }

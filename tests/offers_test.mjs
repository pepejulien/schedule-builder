// VET / VTO offers card helpers (public/app/live/offers-model.js): the fields sent to the hub's
// saveScheduleOffer, the row labels, the take status words.   node tests/offers_test.mjs
import {
  TIERS, defaultForm, dayLabel, timeLabel, offerDays, offerWaves, buildOfferFields, offerWhat, offerLabel,
  takeStatus, whyText, dayOffers, upcomingGroups, headCounts, daySummary, daySummaryLabel, hasOpenOffer, stripHead, offerCounts, countsLabel, stripStatus,
  isCancelled, splitCancelled, cancelledToggle, canDelete, deleteBlocked, cancelConfirm, deleteConfirm, postedLine, editForm,
  buildEditFields, previewFields, previewLabel,
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
const rows = [{ id: 'old', week: '2026-10-04', date: '2026-10-09' }, { id: 'this', week: '2026-10-11', date: '2026-10-12' },
  { id: 'next', week: '2026-10-18', date: '2026-10-20' }];

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
// taken off the Live board again: the Driver App undid the take (2026-10-20)
eq('removed', ['deleted', 'moved', 'back', undefined, 'x'].map((reason) => takeStatus({ status: 'removed', reason }, vet)),
  [{ text: 'Removed (shift deleted)', ask: false }, { text: 'Removed (moved)', ask: false }, { text: 'Removed (back on schedule)', ask: false },
    { text: 'Removed', ask: false }, { text: 'Removed', ask: false }]);
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
const past = { id: 'past', kind: 'vet', role: 'road', wave: '', date: '2026-10-12', slots: 1, at: 0 };
const ug = upcomingGroups([...dayRows, past], '2026-10-13');
eq('upcomingGroups: today on, by day', ug.map((g) => [g.date, g.label, g.offers.map((o) => o.id)]),
  [['2026-10-13', 'Tue Oct 13', ['early', 'late', 'any', 'vto']], ['2026-10-14', 'Wed Oct 14', ['other']]]);
eq('upcomingGroups picked dates', upcomingGroups([...dayRows, past], '2026-10-13', ['2026-10-14', '2026-10-12']).map((g) => g.date), ['2026-10-14']);
eq('upcomingGroups empty pick = all', upcomingGroups(dayRows, '2026-10-14', []).map((g) => g.date), ['2026-10-14']);
eq('upcomingGroups null', upcomingGroups(null, '2026-10-13'), []);
eq('stripHead route', stripHead(dayRows[3]), 'VET · 10:45 AM route');
eq('stripHead backup any wave', stripHead(dayRows[1]), 'VET · backup, any wave');
eq('stripHead VTO', stripHead(dayRows[0]), 'VTO · day off');
const tk = [{ status: 'approved' }, { status: 'applied' }, { status: 'waiting' }, { status: 'pending', counter: true },
  { status: 'pending' }, { status: 'refused' }, { status: 'declined' }];
eq('offerCounts', offerCounts({ slots: 3 }, tk), { offered: 3, taken: 2, waiting: 2 });
eq('offerCounts before the takes are read', offerCounts({ slots: 3, taken: 1 }, undefined), { offered: 3, taken: 1, waiting: 0 });
eq('offerCounts no takes', offerCounts({ slots: 2 }, []), { offered: 2, taken: 0, waiting: 0 });
eq('countsLabel', countsLabel({ offered: 3, taken: 1, waiting: 1 }), '3 offered · 1 approved · 1 waiting');
eq('countsLabel no waiting', countsLabel({ offered: 3, taken: 1, waiting: 0 }), '3 offered · 1 approved');
eq('stripStatus open', stripStatus({ status: 'open' }, { offered: 3, taken: 1 }), { word: 'open', chip: 'green' });
eq('stripStatus filled', stripStatus({ status: 'filled' }, { offered: 3, taken: 3 }), { word: 'full', chip: 'gray' });
eq('stripStatus every spot taken', stripStatus({ status: 'open' }, { offered: 2, taken: 2 }).word, 'full');
eq('stripStatus cancelled', stripStatus({ status: 'closed' }, { offered: 2, taken: 2 }), { word: 'cancelled', chip: 'gray' });
// no clutter (Jose 2026-10-20): cancelled offers left out unless asked for
const cx = { id: 'cx', kind: 'vet', role: 'road', wave: '', date: '2026-10-15', slots: 1, status: 'closed', at: 6 };
const cy = { id: 'cy', kind: 'vto', date: '2026-10-13', slots: 1, status: 'closed', at: 7 };
eq('upcomingGroups hides cancelled', upcomingGroups([...dayRows, cx, cy], '2026-10-13').map((g) => [g.date, g.offers.map((o) => o.id)]),
  [['2026-10-13', ['early', 'late', 'any', 'vto']], ['2026-10-14', ['other']]]);
eq('upcomingGroups with cancelled', upcomingGroups([...dayRows, cx, cy], '2026-10-13', null, true).map((g) => [g.date, g.offers.map((o) => o.id)]),
  [['2026-10-13', ['early', 'late', 'any', 'vto', 'cy']], ['2026-10-14', ['other']], ['2026-10-15', ['cx']]]);
eq('isCancelled', [isCancelled(cx), isCancelled(dayRows[0]), isCancelled(null)], [true, false, false]);
eq('splitCancelled', (({ live, cancelled }) => [live.map((o) => o.id), cancelled.map((o) => o.id)])(splitCancelled([cy, dayRows[0], null, cx])),
  [['vto'], ['cy', 'cx']]);
eq('cancelledToggle', [cancelledToggle(2, false), cancelledToggle(1, true)], ['Show cancelled (2)', 'Hide cancelled (1)']);

// --- delete: cancelled, taken 0, no live take (Jose 2026-10-20)
const cz = { ...cx, taken: 0 };
eq('canDelete nobody took it', canDelete(cz, []), true);
eq('canDelete only dead takes', canDelete(cz, [{ status: 'declined' }, { status: 'refused' }, { status: 'removed' }]), true);
eq('canDelete live takes', ['approved', 'applied', 'waiting', 'pending'].map((st) => canDelete(cz, [{ status: st }])), [false, false, false, false]);
eq('canDelete taken > 0', canDelete({ ...cz, taken: 1 }, []), false);
eq('canDelete not cancelled', canDelete({ ...cz, status: 'open' }, []), false);
eq('canDelete takes not read / refused', [canDelete(cz, undefined), canDelete(cz, null)], [false, false]);
eq('deleteBlocked', [deleteBlocked(cz, []), deleteBlocked(cz, undefined), deleteBlocked(cz, [{ status: 'applied' }]),
  deleteBlocked({ ...cz, taken: 1 }, undefined), deleteBlocked({ ...cz, status: 'open' }, [{ status: 'applied' }])],
  ['', '', 'Kept: a driver took this shift — it stays as the record.', 'Kept: a driver took this shift — it stays as the record.', '']);
const co = { kind: 'vet', role: 'road', wave: '10:45 AM', date: '2026-10-17', slots: 3, taken: 2, status: 'open' };
eq('cancelConfirm nobody on the board', cancelConfirm(co, [{ status: 'waiting' }]),
  "Cancel this offer (VET · Sat Oct 17 · 10:45 AM route · 2 of 3 taken)? Drivers won't be able to take it any more.");
eq('cancelConfirm takes on the board', cancelConfirm(co, [{ status: 'approved' }, { status: 'applied' }, { status: 'declined' }]),
  "Cancel this offer (VET · Sat Oct 17 · 10:45 AM route · 2 of 3 taken)? Drivers won't be able to take it any more.\n\n"
  + "2 drivers already have this shift on the schedule. Cancelling doesn't take it off; remove it on the Live board.");
ok('cancelConfirm one, takes not read', cancelConfirm({ ...co, taken: 1 }, undefined).includes('1 driver already has this shift'));
eq('deleteConfirm', deleteConfirm({ ...co, taken: 0, status: 'closed' }), "Delete this cancelled offer (VET · Sat Oct 17 · 10:45 AM route · 0 of 3 taken)? It's gone for good.");
const t6 = new Date(2026, 9, 13, 18, 0).getTime(), t9 = new Date(2026, 9, 14, 9, 0).getTime();
eq('postedLine', postedLine({ by: 'Ann Boss', at: t6 }), 'Posted by Ann Boss · Tue 6 PM');
eq('postedLine edited + cancelled', postedLine({ by: 'Ann Boss', at: t6, editedBy: 'Bo Lead', editedAt: t9, status: 'closed', closedBy: 'Cy', closedAt: t9 }),
  'Posted by Ann Boss · Tue 6 PM · edited by Bo Lead · Wed 9 AM · cancelled by Cy · Wed 9 AM');
eq('postedLine nobody', postedLine({}), 'Posted by —');

// --- edit: the form from an offer; only spots / audience / note go out, never below taken
const wo = { kind: 'vet', date: '2026-10-17', role: 'backup', wave: '10:45 AM', slots: 3, taken: 2, status: 'open',
  audience: { tiers: ['Solid', 'Top performer'], maxWeekHours: 30 }, mode: 'window', windowHours: 6,
  priority: { tiers: ['Top performer'], maxWeekHours: 40 }, note: 'call first' };
const ef = editForm(wo);
eq('editForm', ef, { kind: 'vet', date: '2026-10-17', role: 'backup', wave: '10:45 AM', slots: '3', sendTo: 'groups',
  tiers: ['Top performer', 'Solid'], under: true, underHours: '30', mode: 'window', windowHours: '6', prTiers: ['Top performer'],
  prHours: '40', note: 'call first' });
eq('editForm everyone, fcfs VTO', editForm({ kind: 'vto', date: '2026-10-17', slots: 2, audience: { tiers: [], maxWeekHours: null }, mode: 'fcfs' }),
  { ...defaultForm(), kind: 'vto', date: '2026-10-17', slots: '2' });
eq('buildEditFields', buildEditFields({ ...ef, slots: '5', note: ' more ' }, wo),
  { fields: { slots: 5, audience: { tiers: ['Top performer', 'Solid'], maxWeekHours: 30 }, note: 'more' } });
eq('buildEditFields spots == taken, everyone, no note', buildEditFields({ ...ef, slots: '2', sendTo: 'all', note: '' }, wo),
  { fields: { slots: 2, audience: { tiers: [], maxWeekHours: null }, note: '' } });
eq('buildEditFields below taken', buildEditFields({ ...ef, slots: '1' }, wo), { error: "Spots can't be below the 2 already taken." });
eq('buildEditFields bad spots', buildEditFields({ ...ef, slots: '51' }, wo).error, 'Spots must be a whole number from 1 to 50.');

// --- recipient preview (drv_offer_preview, SPEC-v2 §6.5)
const pf = previewFields(form({ slots: 'x', note: 'secret', sendTo: 'groups', tiers: ['Fair'] }));
eq('previewFields: the draft without spots / note', pf, { kind: 'vet', date: '2026-10-17', wave: '', slots: 1, role: 'road',
  audience: { tiers: ['Fair'], maxWeekHours: null }, mode: 'fcfs' });
eq('previewFields: same key whatever the spots / note', JSON.stringify(previewFields(form({ slots: '9', note: 'a' }))),
  JSON.stringify(previewFields(form({ slots: '1' }))));
eq('previewFields: not countable yet', previewFields(form({ sendTo: 'groups', tiers: [] })), null);
eq('previewLabel', previewLabel({ state: 'ok', res: { eligible: 22, withApp: 4, withPush: 1 } }),
  '22 drivers can see this · 4 use the app · 1 gets a phone alert');
eq('previewLabel ones and zeros', previewLabel({ state: 'ok', res: { eligible: 1, withApp: 1, withPush: 0 } }),
  '1 driver can see this · 1 uses the app · 0 get a phone alert');
eq('previewLabel loading', previewLabel({ state: 'loading' }), '— drivers can see this · — use the app · — get a phone alert');
eq('previewLabel error', previewLabel({ state: 'err' }), "Couldn't count");

// --- day headers
eq('headCounts', headCounts({ routes_filled: 31, routes: 32, backup_filled: 6, backup: 8 }), { drivers: '31/32 drivers', backups: '6/8 backups' });
const hdr = [
  { id: 'a', kind: 'vet', date: '2026-10-13', slots: 2, taken: 1, status: 'open' },
  { id: 'b', kind: 'vet', date: '2026-10-13', slots: 1, taken: 0, status: 'filled' },
  { id: 'c', kind: 'vto', date: '2026-10-13', slots: 2, taken: 0, status: 'open' },
  { id: 'x', kind: 'vto', date: '2026-10-13', slots: 5, taken: 0, status: 'closed' },
  { id: 'd', kind: 'vet', date: '2026-10-14', slots: 1, taken: 0, status: 'filled' }];
const hTakes = { a: [{ status: 'approved' }, { status: 'waiting' }], b: [{ status: 'applied', counter: true }],
  c: [{ status: 'approved' }, { status: 'applied' }, { status: 'pending', counter: true }] };
eq('daySummary', daySummary(hdr, '2026-10-13', hTakes), [
  { kind: 'vet', offered: 3, approved: 2, waiting: 1 }, { kind: 'vto', offered: 2, approved: 2, waiting: 1 }]);
eq('daySummary takes not read yet', daySummary(hdr, '2026-10-13', {}), [
  { kind: 'vet', offered: 3, approved: 1, waiting: 0 }, { kind: 'vto', offered: 2, approved: 0, waiting: 0 }]);
eq('daySummary only closed', daySummary([hdr[3]], '2026-10-13', {}), []);
eq('daySummary none', daySummary(null, '2026-10-13'), []);
eq('daySummaryLabel', daySummaryLabel({ kind: 'vet', offered: 3, approved: 1, waiting: 0 }), 'VET 3 · 1 approved');
eq('daySummaryLabel waiting', daySummaryLabel({ kind: 'vto', offered: 2, approved: 2, waiting: 1 }), 'VTO 2 · 2 approved · 1 waiting');
eq('hasOpenOffer', [hasOpenOffer(hdr, '2026-10-13'), hasOpenOffer(hdr, '2026-10-14'), hasOpenOffer(null, '2026-10-13')], [true, false, false]);

console.log(`${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log('FAIL ' + f); process.exit(1); }

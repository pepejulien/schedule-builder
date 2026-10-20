// VET / VTO offers (Driver App SPEC-v2 §6.4, 2026-10-12; Jose 2026-10-13: a strip at the top of the
// Live board, no card at the bottom). Post an extra shift (VET) or a day off (VTO) to drivers' phones,
// and follow the offers: who took them, counters to answer, Edit, Cancel offer, Delete (2026-10-20: the same rows
// on the Requests page, OfferRow), with a recipient count before Post / Save. Drivers take them in the Driver
// App; the hub puts approved ones on the board (route counts never change). The words and the fields sent come
// from offers-model.js (pure, tested by tests/offers_test.mjs).
import { html } from '../preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { toast } from '../store.js';
import { Banner, Spinner } from '../ui.js';
import { watchOffers, watchOfferTakes, saveOffer, closeOffer, canDecideCounter, decideCounter, canEditOffers, editOffer,
  deleteOffer, canPreviewOffer, previewOffer } from '../api.js';
import { toISODate } from '../lib/weeks.js';
import {
  TIERS, defaultForm, offerDays, offerWaves, buildOfferFields, takeStatus, timeLabel, dayLabel,
  dayOffers, upcomingGroups, stripHead, offerCounts, countsLabel, stripStatus, daySummary, daySummaryLabel, hasOpenOffer,
  isCancelled, cancelledToggle, canDelete, deleteBlocked, cancelConfirm, deleteConfirm, postedLine, editForm, buildEditFields,
  previewFields, previewLabel,
} from './offers-model.js';
import { offerRole, offerLine, takeTone } from './requests-model.js';

// One schedule_offers listener however many strips are mounted (the Requests page shares it too, 2026-10-19).
const feed = { rows: undefined, subs: new Set(), un: null };
export function useOffers() {
  const [rows, setRows] = useState(feed.rows);
  useEffect(() => {
    feed.subs.add(setRows);
    if (!feed.un) feed.un = watchOffers(null, (r) => { feed.rows = r; feed.subs.forEach((f) => f(r)); });
    else setRows(feed.rows);
    return () => {
      feed.subs.delete(setRows);
      if (!feed.subs.size) { const un = feed.un; feed.un = null; feed.rows = undefined; if (un) un(); }
    };
  }, []);
  return rows;
}

// One takes listener per offer, shared by the strip's row and the day header (refcounted).
const takeFeeds = new Map();                     // offerId -> {rows, subs, un}
function subTakes(id, fn) {
  let f = takeFeeds.get(id);
  if (!f) {
    f = { rows: undefined, subs: new Set(), un: null };
    takeFeeds.set(id, f);
    f.un = watchOfferTakes(id, (t) => { f.rows = t; f.subs.forEach((s) => s(t)); });
  }
  f.subs.add(fn);
  if (f.rows !== undefined) fn(f.rows);
  return () => {
    f.subs.delete(fn);
    if (!f.subs.size) { takeFeeds.delete(id); if (f.un) f.un(); }
  };
}
export function useTakes(id) {
  const [t, setT] = useState(() => (takeFeeds.get(id) || {}).rows);
  useEffect(() => subTakes(id, setT), [id]);
  return t;
}
// {offerId: takes} for these offers (ids in a stable order)
export function useTakesMap(ids) {
  const [map, setMap] = useState({});
  const key = ids.join(',');
  useEffect(() => {
    const uns = ids.map((id) => subTakes(id, (t) => setMap((m) => (m[id] === t ? m : { ...m, [id]: t }))));
    return () => uns.forEach((u) => u());
  }, [key]);
  return map;
}

// A day header's VET / VTO line (offers that aren't closed): "VET 3 · 1 approved · 1 waiting".
// onPick (optional) makes it a button. Nothing when the day has none.
export function OfferDayLine({ date, onPick }) {
  const rows = useOffers();
  const ids = (rows || []).filter((o) => o && o.date === date && o.status !== 'closed').map((o) => o.id).sort();
  const takes = useTakesMap(ids);
  const sum = daySummary(rows, date, takes);
  if (!sum.length) return '';
  const text = sum.map(daySummaryLabel).join(' · ');
  return onPick ? html`<button class="of-dayline" title="Show this day's VET / VTO" onClick=${onPick}>${sum.map((x) => html`<span>${daySummaryLabel(x)}</span>`)}</button>`
    : html`<div class="of-dayline" aria-label=${text}>${sum.map((x) => html`<span>${daySummaryLabel(x)}</span>`)}</div>`;
}

// The phone's day pill dot: that date has an open offer.
export function OfferDot({ date }) {
  const rows = useOffers();
  return hasOpenOffer(rows, date) ? html`<i class="of-dot" aria-label="Open VET / VTO"></i>` : '';
}

function TierChecks({ list, onChange, name, disabled }) {
  const flip = (t) => onChange(list.includes(t) ? list.filter((x) => x !== t) : [...list, t]);
  return html`<div class="row of-tiers" role="group" aria-label=${name}>
    ${TIERS.map((t) => html`<label class="dv-check"><input type="checkbox" checked=${list.includes(t)} disabled=${disabled}
      onChange=${() => flip(t)} />${t}</label>`)}
  </div>`;
}

const hoursBox = (value, onInput, label, disabled) => html`<input type="number" min="1" max="168" step="1" class="of-num"
  value=${value} onInput=${(e) => onInput(e.target.value)} aria-label=${label} disabled=${disabled} />`;

// The recipient preview (Driver App drv_offer_preview, 2026-10-20): {state: idle | loading | ok | err, res} for the
// form, asked again ~400 ms after the day / kind / role / wave / audience / approval last changed (spots and the
// note change nobody's card); a reply to an older draft is dropped. Never blocks posting.
function useRecipients(f) {
  const [st, setSt] = useState({ state: 'idle' });
  const seq = useRef(0);
  const fields = canPreviewOffer() ? previewFields(f) : null;
  const key = fields ? JSON.stringify(fields) : '';
  useEffect(() => {
    const n = ++seq.current;
    if (!key) { setSt({ state: 'idle' }); return undefined; }
    setSt({ state: 'loading' });
    const t = setTimeout(() => {
      Promise.resolve().then(() => previewOffer(JSON.parse(key)))
        .then((res) => { if (seq.current === n) setSt({ state: 'ok', res }); })
        .catch(() => { if (seq.current === n) setSt({ state: 'err' }); });
    }, 400);
    return () => { clearTimeout(t); seq.current++; };
  }, [key]);
  return st;
}

// The offer form, opened inline in the strip and on the Requests page. Post (no offer): days = the shown week's
// view.days; today = 'YYYY-MM-DD'; date = the day it opens on (the first day left when it isn't postable).
// Edit (offer = the schedule_offers row, Jose 2026-10-20): only spots, who it's sent to and the note change; the
// kind, day, role, wave and approval are shown locked (drivers were told that shift — cancel and post again to
// change them). onDone = after a post / save; onCancel shows a Cancel; uid keeps radio names apart.
export function OfferForm({ days, today, date, offer, onDone, onCancel, uid = 's' }) {
  const editing = !!offer;
  const choices = editing ? [] : offerDays(days, today);
  const [f, setF] = useState(() => (editing ? editForm(offer) : { ...defaultForm(), date: date || '' }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (patch) => { setErr(''); setF((o) => ({ ...o, ...patch })); };
  // the picked day follows the shown week: the first day left when it isn't in it (posting only)
  const firstDate = choices.length ? choices[0].date : '';
  const dateOk = editing || choices.some((x) => x.date === f.date);
  useEffect(() => { if (!dateOk) setF((o) => ({ ...o, date: firstDate, wave: '' })); }, [dateOk, firstDate]);
  const info = (days || []).find((x) => x.date === f.date);
  const waves = editing ? (f.wave ? [f.wave] : []) : offerWaves(info);
  const vet = f.kind === 'vet';
  const recipients = useRecipients(f);

  async function post() {
    const r = buildOfferFields(f);
    if (r.error) { setErr(r.error); return; }
    setBusy(true); setErr('');
    try {
      await saveOffer(r.fields);
      toast('Offer posted.');
      setF((o) => ({ ...defaultForm(), kind: o.kind, date: o.date }));
      if (onDone) onDone();
    } catch (e) {
      setErr('Could not post the offer: ' + (e.message || e));
    } finally { setBusy(false); }
  }
  async function save() {
    const r = buildEditFields(f, offer);
    if (r.error) { setErr(r.error); return; }
    setBusy(true); setErr('');
    try {
      await editOffer(offer.id, r.fields);
      toast('Offer saved.');
      setBusy(false);
      if (onDone) onDone();
    } catch (e) {
      const code = String((e && e.code) || '');
      // a driver took a spot between the read and the write: the rules refuse the status
      setErr(code === 'permission-denied' ? 'Someone just took it — try again.'
        : code.startsWith('offer/') ? e.message : 'Could not save the offer: ' + (e.message || e));
      setBusy(false);
    }
  }

  const to = 'of-to-' + uid, md = 'of-mode-' + uid, mw = 'of-mode-w-' + uid;
  return html`<div class="of-form">
    <h3>${editing ? 'Edit offer' : 'Post an offer'}</h3>
    <div class="seg" role="group" aria-label="Kind of offer">
      <button class=${vet ? 'on' : ''} aria-pressed=${vet} disabled=${editing && !vet} onClick=${() => !editing && set({ kind: 'vet' })}>VET — extra shift</button>
      <button class=${vet ? '' : 'on'} aria-pressed=${!vet} disabled=${editing && vet} onClick=${() => !editing && set({ kind: 'vto' })}>VTO — day off</button>
    </div>
    <div class="row of-fields">
      <label class="fld"><span>Day</span>
        ${editing ? html`<select value=${f.date} disabled><option value=${f.date}>${dayLabel(f.date)}</option></select>`
          : choices.length ? html`<select value=${f.date} onChange=${(e) => set({ date: e.target.value, wave: '' })}>
          ${choices.map((x) => html`<option value=${x.date}>${x.label}</option>`)}
        </select>` : html`<span class="muted">No days left in this week</span>`}</label>
      ${vet ? html`
      <div class="fld"><span>Role</span>
        <div class="seg" role="group" aria-label="Role">
          <button class=${f.role === 'road' ? 'on' : ''} aria-pressed=${f.role === 'road'} disabled=${editing && f.role !== 'road'}
            onClick=${() => !editing && set({ role: 'road' })}>Route</button>
          <button class=${f.role === 'backup' ? 'on' : ''} aria-pressed=${f.role === 'backup'} disabled=${editing && f.role !== 'backup'}
            onClick=${() => !editing && set({ role: 'backup' })}>Backup</button>
        </div></div>
      <label class="fld"><span>Wave</span>
        <select value=${f.wave} disabled=${editing} onChange=${(e) => set({ wave: e.target.value })}>
          <option value="">Any wave</option>
          ${waves.map((w) => html`<option value=${w}>${w}</option>`)}
        </select></label>` : ''}
      <label class="fld"><span>Spots</span>
        <input type="number" min=${editing ? Math.max(1, Number(offer.taken) || 0) : 1} max="50" step="1" class="of-num" value=${f.slots}
          onInput=${(e) => set({ slots: e.target.value })} /></label>
    </div>
    ${editing && Number(offer.taken) > 0 ? html`<div class="hint" style="margin:0">${Number(offer.taken)} already taken — spots can't go below that.</div>` : ''}

    <h3>Send to</h3>
    <label class="row lv-radio"><input type="radio" name=${to} checked=${f.sendTo === 'all'}
      onChange=${() => set({ sendTo: 'all' })} /><span>Everyone</span></label>
    <label class="row lv-radio"><input type="radio" name=${to} checked=${f.sendTo === 'groups'}
      onChange=${() => set({ sendTo: 'groups' })} /><span>Pick groups</span></label>
    ${f.sendTo === 'groups' ? html`<div class="of-indent">
      <${TierChecks} list=${f.tiers} name="Tiers to send to" onChange=${(tiers) => set({ tiers })} />
      <div class="row"><label class="dv-check"><input type="checkbox" checked=${f.under}
        onChange=${(e) => set({ under: e.target.checked })} />Under</label>
        ${hoursBox(f.underHours, (v) => set({ underHours: v, under: true }), 'Hours this week')}
        <span class="dv-check">hours this week</span></div>
    </div>` : ''}

    <h3>Approval</h3>
    <label class="row lv-radio"><input type="radio" name=${md} checked=${f.mode === 'fcfs'} disabled=${editing}
      onChange=${() => set({ mode: 'fcfs' })} /><span>First come, first served</span></label>
    <div class="row lv-radio" style="align-items:center"><input type="radio" name=${md} id=${mw} checked=${f.mode === 'window'}
      disabled=${editing} onChange=${() => set({ mode: 'window' })} /><label for=${mw}>Wait</label>
      ${hoursBox(f.windowHours, (v) => set({ windowHours: v, mode: 'window' }), 'Hours to wait', editing)}
      <label for=${mw}>hours, then pick</label></div>
    ${f.mode === 'window' ? html`<div class="of-indent">
      <div class="muted">Approve right away:</div>
      <${TierChecks} list=${f.prTiers} name="Tiers approved right away" disabled=${editing} onChange=${(prTiers) => set({ prTiers })} />
      <div class="row"><span class="dv-check">under</span>
        ${hoursBox(f.prHours, (v) => set({ prHours: v }), 'Hours this week to approve right away', editing)}
        <span class="dv-check">hours this week</span></div>
    </div>` : ''}

    ${editing ? html`<p class="hint" style="margin-top:12px">The day, the shift and the approval can't change — drivers
      were told them. To change them, cancel this offer and post a new one.</p>`
      : html`<p class="hint" style="margin-top:12px">Drivers already working that day or over the hour limits won't see it.
      Taking it can't be undone. Route counts don't change.</p>`}
    <label class="fld"><span>Note (managers only)</span>
      <input type="text" maxlength="300" value=${f.note} onInput=${(e) => set({ note: e.target.value })} style="width:100%" /></label>
    ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
    ${canPreviewOffer() ? html`<p class="hint" style="margin:10px 0 6px" aria-live="polite">${previewLabel(recipients)}</p>` : ''}
    <div class="row">
      ${editing ? html`<button class="primary" disabled=${busy} onClick=${save}>Save</button>`
        : html`<button class="primary" disabled=${busy || !choices.length} onClick=${post}>Post</button>`}
      ${onCancel ? html`<button disabled=${busy} onClick=${onCancel}>Cancel</button>` : ''}
      ${busy ? html`<span><${Spinner}/> ${editing ? 'Saving…' : 'Posting…'}</span>` : ''}
    </div>
  </div>`;
}

// who took an offer (undefined = loading, null = refused); counters get Yes / No. Waiting window takes only
// say "Waiting until <time>": the Driver App decides them when the wait ends.
function TakesList({ o, takes }) {
  const [busy, setBusy] = useState('');          // the tid being answered
  if (takes === undefined) return html`<p class="muted"><${Spinner}/> Loading…</p>`;
  if (takes === null) return html`<p class="muted">Could not read who took it.</p>`;
  if (!takes.length) return html`<p class="muted">Nobody has taken it yet.</p>`;
  async function answer(t, yes) {
    setBusy(t.tid);
    try { await decideCounter(o.id, t.tid, yes); } catch (e) { toast('Could not save the answer: ' + (e.message || e), 'err'); }
    setBusy('');
  }
  return html`<ul class="of-takes">${takes.map((t) => {
    const st = takeStatus(t, o);
    return html`<li class="row">
      <b>${t.name || t.tid}</b>
      <span class="muted">${timeLabel(t.at)}</span>
      <span>${st.text}</span>
      ${st.ask && canDecideCounter() && !isCancelled(o) ? html`
        <button class="small" disabled=${!!busy} onClick=${() => answer(t, true)}>Yes</button>
        <button class="small" disabled=${!!busy} onClick=${() => answer(t, false)}>No</button>` : ''}
    </li>`;
  })}</ul>`;
}

const lc1 = (s) => String(s || '').charAt(0).toLowerCase() + String(s || '').slice(1);

// One offer, the same on the Live board's strip and the Requests page (Jose 2026-10-20: everything from either):
// look 'strip' = "▸ VET · 10:45 AM route · 3 offered · 1 approved · open"; look 'card' = the Requests card (chip ·
// day · role, "1 of 3 taken · open · first come", who took it). A cancelled row nobody took has Delete right on
// it. ▸ opens: who posted / edited it, the note, who took it (counters: Yes / No), Edit…, Cancel offer.
export function OfferRow({ o, look = 'strip', expanded, onToggle, uid = 'r' }) {
  const takes = useTakes(o.id);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const c = offerCounts(o, takes);
  const st = stripStatus(o, c);
  const cancelled = isCancelled(o);
  const can = canEditOffers();
  const canEdit = can && !cancelled && String(o.date || '') >= toISODate(new Date());
  const del = can && canDelete(o, takes);
  const kept = cancelled ? deleteBlocked(o, takes) : '';

  async function cancel() {
    if (!window.confirm(cancelConfirm(o, takes))) return;
    setBusy(true); setEditing(false);
    try { await closeOffer(o.id); toast('Offer cancelled.'); } catch (e) { toast('Could not cancel it: ' + (e.message || e), 'err'); }
    setBusy(false);
  }
  async function remove() {
    if (!window.confirm(deleteConfirm(o))) return;
    setBusy(true);
    try { await deleteOffer(o.id); toast('Offer deleted.'); }            // the row goes with the listener
    catch (e) {
      toast(e && e.code === 'permission-denied' ? "Couldn't delete it — a driver has taken it." : 'Could not delete it: ' + (e.message || e), 'err');
      setBusy(false);
    }
  }
  const delBtn = del ? html`<button class="small" disabled=${busy} title="Delete this cancelled offer for good"
    onClick=${remove}>Delete</button>` : '';
  const arrow = expanded ? '▾' : '▸';
  const more = expanded ? html`<div class="of-indent">
    <div class="muted">${postedLine(o)}</div>
    ${o.note ? html`<div class="muted">Note: <i>${o.note}</i></div>` : ''}
    <${TakesList} o=${o} takes=${takes} />
    ${kept ? html`<div class="muted">${kept}</div>` : ''}
    ${editing ? html`<div class="of-strip-form"><${OfferForm} offer=${o} uid=${uid + '-' + o.id}
      onDone=${() => setEditing(false)} onCancel=${() => setEditing(false)} /></div>`
      : !cancelled ? html`<div class="row">
        ${canEdit ? html`<button class="small" disabled=${busy} onClick=${() => setEditing(true)}>Edit…</button>` : ''}
        <button class="small" disabled=${busy} onClick=${cancel}>Cancel offer</button></div>` : ''}
  </div>` : '';

  if (look === 'card') {
    return html`<div class="rq-offer">
      <div class="rq-of1"><button class="link rq-oftog" aria-expanded=${expanded} onClick=${onToggle}>${arrow}
        <span class=${'chip ' + (o.kind === 'vto' ? 'amber' : 'green')}>${o.kind === 'vto' ? 'VTO' : 'VET'}</span>
        <b>${dayLabel(o.date)}</b><span>${offerRole(o)}</span></button>${delBtn}</div>
      <div class="muted rq-of2">${offerLine(o, takes)}</div>
      ${!expanded && Array.isArray(takes) && takes.length ? html`<div class="rq-of3">${takes.map((t, i) => html`${i ? ' · ' : ''}<span class="rq-taker">${t.name || t.tid}${' '}<span
        class=${'rq-tk ' + takeTone(t)}>${lc1(takeStatus(t, o).text)}</span></span>`)}</div>` : ''}
      ${more}
    </div>`;
  }
  return html`<li class="of-strip-row">
    <div class="row of-strip-head">
      <button class="link of-strip-btn" aria-expanded=${expanded} onClick=${onToggle}>
        <span>${arrow} <b>${stripHead(o)}</b></span>
        <span class="muted">${countsLabel(c)}</span>
        <span class=${'chip ' + st.chip}>${st.word}</span></button>
      ${delBtn}</div>
    ${more}
  </li>`;
}

// "Show cancelled (N)" / "Hide cancelled (N)" (the "Answered (N)" link pattern)
export function CancelledToggle({ n, shown, onToggle }) {
  if (!n) return '';
  return html`<button class="link rq-answered" aria-expanded=${shown} onClick=${onToggle}>
    ${cancelledToggle(n, shown)} ${shown ? '▾' : '▸'}</button>`;
}

// The strip at the top of the Live board (Jose 2026-10-13). One day picked (the computer's
// "Working on:" single day, or the phone's Day view): date + day -> that day's offers.
// Otherwise (All days, several days, the phone's Week view): every offer from today on, by day,
// only the picked dates when dates is a list. days / today: the shown week's view.days and today.
// Cancelled offers stay hidden behind "Show cancelled (N)" (Jose 2026-10-20).
// The form is the board's: postDate = the day it's open on (null: closed), onPost(date) opens it,
// onPostDone closes it. No offers in scope and no form: no strip.
export function OffersStrip({ date, day, dates, days, today, postDate, onPost, onPostDone }) {
  const rows = useOffers();
  const [open, setOpen] = useState({});
  const [showC, setShowC] = useState(false);
  const one = !!date;
  const posting = postDate != null;
  const postable = offerDays(days, today);
  const canPost = one ? postable.some((x) => x.date === date) : postable.length > 0;
  if (rows === undefined && !posting) return '';
  if (rows === null) return html`<div class="of-strip"><span class="muted">Could not read the VET / VTO offers.</span></div>`;
  const toggle = (id) => setOpen((s) => ({ ...s, [id]: !s[id] }));
  const list = (offers) => html`<ul class="of-strip-list">${offers.map((o) => html`<${OfferRow} o=${o} key=${o.id}
    expanded=${!!open[o.id]} onToggle=${() => toggle(o.id)} uid="s" />`)}</ul>`;
  let head = '', shown = '', nC = 0;
  if (one) {
    const all = dayOffers(rows, date);
    nC = all.filter(isCancelled).length;
    const offers = showC ? all : all.filter((o) => !isCancelled(o));
    head = `VET / VTO · ${dayLabel(date)}`;
    if (offers.length) shown = list(offers);
  } else {
    const groups = upcomingGroups(rows, today, dates, showC);
    nC = upcomingGroups((rows || []).filter(isCancelled), today, dates, true).reduce((n, g) => n + g.offers.length, 0);
    head = 'VET / VTO · upcoming';
    if (groups.length) shown = groups.map((g) => html`<div class="of-strip-day" key=${g.date}>${g.label}</div>${list(g.offers)}`);
  }
  // nothing in scope and no form open: no strip at all (the corner / day-heading button opens the form)
  if (!shown && !nC && !posting) return '';
  return html`<div class="of-strip" aria-label="VET / VTO">
    ${shown || nC ? html`<div class="of-strip-h">${head}</div>${shown}
      <${CancelledToggle} n=${nC} shown=${showC} onToggle=${() => setShowC((x) => !x)} />` : ''}
    ${posting ? html`<div class="of-strip-form"><${OfferForm} key=${postDate} days=${days} today=${today} date=${postDate}
      onDone=${onPostDone} onCancel=${onPostDone} /></div>`
      : canPost && onPost ? html`<button class="small" onClick=${() => onPost(one ? date : today)}>${one ? `Post an offer for ${day}` : 'Post an offer'}</button>` : ''}
  </div>`;
}

// VET / VTO offers (Driver App SPEC-v2 §6.4, 2026-10-12): the Live board card after "Who can work
// extra?". Post an extra shift (VET) or a day off (VTO) to drivers' phones, and follow the open
// offers: who took them, counters to answer, Close. Drivers take them in the Driver App; the hub
// puts approved ones on the board (route counts never change). The words and the fields sent come
// from offers-model.js (pure, tested by tests/offers_test.mjs).
import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { toast } from '../store.js';
import { Banner, Spinner } from '../ui.js';
import { watchOffers, watchOfferTakes, saveOffer, closeOffer, canDecideCounter, decideCounter } from '../api.js';
import {
  TIERS, defaultForm, offerDays, offerWaves, buildOfferFields, offerLabel, offerStatusWord, shownOffers,
  takeStatus, timeLabel, dayLabel, dayOffers, stripHead, offerCounts, countsLabel, stripStatus,
} from './offers-model.js';

const STATUS_CHIP = { open: 'green', filled: 'blue', closed: 'gray' };

// One schedule_offers listener for the card's list and the day strip (both mounted together).
const feed = { rows: undefined, subs: new Set(), un: null };
function useOffers() {
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

function TierChecks({ list, onChange, name }) {
  const flip = (t) => onChange(list.includes(t) ? list.filter((x) => x !== t) : [...list, t]);
  return html`<div class="row of-tiers" role="group" aria-label=${name}>
    ${TIERS.map((t) => html`<label class="dv-check"><input type="checkbox" checked=${list.includes(t)}
      onChange=${() => flip(t)} />${t}</label>`)}
  </div>`;
}

const hoursBox = (value, onInput, label) => html`<input type="number" min="1" max="168" step="1" class="of-num"
  value=${value} onInput=${(e) => onInput(e.target.value)} aria-label=${label} />`;

// days = the shown week's view.days; today = 'YYYY-MM-DD'
export function Offers({ days, today }) {
  return html`<div class="card" id="lv-offers">
    <h2>VET / VTO</h2>
    <${OfferForm} days=${days} today=${today} uid="c" />
    <h3>Open offers</h3>
    <${OfferList} today=${today} />
  </div>`;
}

// The "Post an offer" form: the card's, and the day strip's inline one (Jose 2026-10-13).
// date = the day it opens on; onDone = after a post (the strip folds it); onCancel shows a Cancel;
// uid keeps two forms' radio names apart.
function OfferForm({ days, today, date, onDone, onCancel, uid }) {
  const choices = offerDays(days, today);
  const [f, setF] = useState(() => ({ ...defaultForm(), date: date || '' }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (patch) => { setErr(''); setF((o) => ({ ...o, ...patch })); };
  // the picked day follows the shown week: the first day left when it isn't in it
  const firstDate = choices.length ? choices[0].date : '';
  const dateOk = choices.some((x) => x.date === f.date);
  useEffect(() => { if (!dateOk) setF((o) => ({ ...o, date: firstDate, wave: '' })); }, [dateOk, firstDate]);
  const info = (days || []).find((x) => x.date === f.date);
  const waves = offerWaves(info);
  const vet = f.kind === 'vet';

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

  const to = 'of-to-' + uid, md = 'of-mode-' + uid, mw = 'of-mode-w-' + uid;
  return html`<div class="of-form">
    <h3>Post an offer</h3>
    <div class="seg" role="group" aria-label="Kind of offer">
      <button class=${vet ? 'on' : ''} aria-pressed=${vet} onClick=${() => set({ kind: 'vet' })}>VET — extra shift</button>
      <button class=${vet ? '' : 'on'} aria-pressed=${!vet} onClick=${() => set({ kind: 'vto' })}>VTO — day off</button>
    </div>
    <div class="row of-fields">
      <label class="fld"><span>Day</span>
        ${choices.length ? html`<select value=${f.date} onChange=${(e) => set({ date: e.target.value, wave: '' })}>
          ${choices.map((x) => html`<option value=${x.date}>${x.label}</option>`)}
        </select>` : html`<span class="muted">No days left in this week</span>`}</label>
      ${vet ? html`
      <div class="fld"><span>Role</span>
        <div class="seg" role="group" aria-label="Role">
          <button class=${f.role === 'road' ? 'on' : ''} aria-pressed=${f.role === 'road'} onClick=${() => set({ role: 'road' })}>Route</button>
          <button class=${f.role === 'backup' ? 'on' : ''} aria-pressed=${f.role === 'backup'} onClick=${() => set({ role: 'backup' })}>Backup</button>
        </div></div>
      <label class="fld"><span>Wave</span>
        <select value=${f.wave} onChange=${(e) => set({ wave: e.target.value })}>
          <option value="">Any wave</option>
          ${waves.map((w) => html`<option value=${w}>${w}</option>`)}
        </select></label>` : ''}
      <label class="fld"><span>Spots</span>
        <input type="number" min="1" max="50" step="1" class="of-num" value=${f.slots}
          onInput=${(e) => set({ slots: e.target.value })} /></label>
    </div>

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
    <label class="row lv-radio"><input type="radio" name=${md} checked=${f.mode === 'fcfs'}
      onChange=${() => set({ mode: 'fcfs' })} /><span>First come, first served</span></label>
    <div class="row lv-radio" style="align-items:center"><input type="radio" name=${md} id=${mw} checked=${f.mode === 'window'}
      onChange=${() => set({ mode: 'window' })} /><label for=${mw}>Wait</label>
      ${hoursBox(f.windowHours, (v) => set({ windowHours: v, mode: 'window' }), 'Hours to wait')}
      <label for=${mw}>hours, then pick</label></div>
    ${f.mode === 'window' ? html`<div class="of-indent">
      <div class="muted">Approve right away:</div>
      <${TierChecks} list=${f.prTiers} name="Tiers approved right away" onChange=${(prTiers) => set({ prTiers })} />
      <div class="row"><span class="dv-check">under</span>
        ${hoursBox(f.prHours, (v) => set({ prHours: v }), 'Hours this week to approve right away')}
        <span class="dv-check">hours this week</span></div>
    </div>` : ''}

    <p class="hint" style="margin-top:12px">Drivers already working that day or over the hour limits won't see it.
      Taking it can't be undone. Route counts don't change.</p>
    <label class="fld"><span>Note (managers only)</span>
      <input type="text" maxlength="300" value=${f.note} onInput=${(e) => set({ note: e.target.value })} style="width:100%" /></label>
    ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
    <div class="row">
      <button class="primary" disabled=${busy || !choices.length} onClick=${post}>Post</button>
      ${onCancel ? html`<button disabled=${busy} onClick=${onCancel}>Cancel</button>` : ''}
      ${busy ? html`<span><${Spinner}/> Posting…</span>` : ''}
    </div>
  </div>`;
}

function OfferList({ today }) {
  const rows = useOffers();                      // undefined = loading, null = refused
  const [open, setOpen] = useState({});          // {id: true} expanded
  if (rows === undefined) return html`<p class="muted"><${Spinner}/> Loading offers…</p>`;
  if (rows === null) return html`<${Banner} kind="err">Could not read the offers.<//>`;
  const list = shownOffers(rows, today);
  if (!list.length) return html`<p class="muted">No offers this week or later.</p>`;
  return html`<ul class="of-list">${list.map((o) => html`<${OfferRow} o=${o} key=${o.id} expanded=${!!open[o.id]}
    onToggle=${() => setOpen((s) => ({ ...s, [o.id]: !s[o.id] }))} />`)}</ul>`;
}

function OfferRow({ o, expanded, onToggle }) {
  const [busy, setBusy] = useState(false);
  async function close() {
    if (!window.confirm(`Close this offer (${offerLabel(o)})? Drivers won't be able to take it any more.`)) return;
    setBusy(true);
    try { await closeOffer(o.id); toast('Offer closed.'); } catch (e) { toast('Could not close it: ' + (e.message || e), 'err'); }
    setBusy(false);
  }
  return html`<li class="of-row">
    <div class="row">
      <button class="link" aria-expanded=${expanded} onClick=${onToggle}>${expanded ? '▾' : '▸'} ${offerLabel(o)}</button>
      <span class=${'chip ' + (STATUS_CHIP[o.status] || 'green')}>${offerStatusWord(o)}</span>
      ${o.status === 'open' ? html`<button class="small" disabled=${busy} onClick=${close}>Close</button>` : ''}
    </div>
    ${expanded ? html`<div class="of-indent">
      <div class="muted">Posted by ${o.by || '—'}${o.at ? ' · ' + timeLabel(o.at) : ''}${o.note ? html` · <i>${o.note}</i>` : ''}</div>
      <${Takes} o=${o} />
    </div>` : ''}
  </li>`;
}

function Takes({ o }) {
  const [takes, setTakes] = useState(undefined);
  useEffect(() => watchOfferTakes(o.id, (t) => setTakes(t)), [o.id]);
  return html`<${TakesList} o=${o} takes=${takes} />`;
}

// who took an offer (undefined = loading, null = refused); counters get Yes / No
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
      ${st.ask && canDecideCounter() ? html`
        <button class="small" disabled=${!!busy} onClick=${() => answer(t, true)}>Yes</button>
        <button class="small" disabled=${!!busy} onClick=${() => answer(t, false)}>No</button>` : ''}
    </li>`;
  })}</ul>`;
}

// The day strip (Jose 2026-10-13): the picked day's offers at the top of the Live board — the
// computer's "Working on:" single day, or the phone's Day view. date = 'YYYY-MM-DD', day = 'Tue';
// days / today as the card gets them; the Post button opens the card's form right here.
export function DayStrip({ date, day, days, today }) {
  const rows = useOffers();
  const [open, setOpen] = useState({});
  const [posting, setPosting] = useState(false);
  useEffect(() => setPosting(false), [date]);
  const canPost = offerDays(days, today).some((x) => x.date === date);
  if (rows === undefined || rows === null) return '';
  const list = dayOffers(rows, date);
  return html`<div class="of-strip" aria-label=${'VET / VTO on ' + dayLabel(date)}>
    ${list.length ? html`<div class="of-strip-h">VET / VTO · ${dayLabel(date)}</div>
      <ul class="of-strip-list">${list.map((o) => html`<${StripRow} o=${o} key=${o.id} expanded=${!!open[o.id]}
        onToggle=${() => setOpen((s) => ({ ...s, [o.id]: !s[o.id] }))} />`)}</ul>`
      : html`<div class="of-strip-h">No VET / VTO for ${day}</div>`}
    ${canPost && posting ? html`<div class="of-strip-form"><${OfferForm} days=${days} today=${today} date=${date} uid="s"
      onDone=${() => setPosting(false)} onCancel=${() => setPosting(false)} /></div>`
      : canPost ? html`<button class="small" onClick=${() => setPosting(true)}>Post an offer for ${day}</button>` : ''}
  </div>`;
}

function StripRow({ o, expanded, onToggle }) {
  const [takes, setTakes] = useState(undefined);
  useEffect(() => watchOfferTakes(o.id, (t) => setTakes(t)), [o.id]);
  const c = offerCounts(o, takes);
  const st = stripStatus(o, c);
  return html`<li class="of-strip-row">
    <button class="link of-strip-btn" aria-expanded=${expanded} onClick=${onToggle}>
      <span>${expanded ? '▾' : '▸'} <b>${stripHead(o)}</b></span>
      <span class="muted">${countsLabel(c)}</span>
      <span class=${'chip ' + st.chip}>${st.word}</span></button>
    ${expanded ? html`<div class="of-indent"><${TakesList} o=${o} takes=${takes} /></div>` : ''}
  </li>`;
}

// The Requests page (Jose 2026-10-19: it replaces the Today page, which nobody used — the Live
// schedule is the landing page now). Two cards: the days off drivers asked for (schedule_timeoff,
// from the drivers' app or typed in by a manager) checked against the published Live schedule, and
// the VET / VTO offers. A red line on top names whoever asked off but is still on the schedule; the
// nav's Requests item carries the same count (useConflictCount). The words and the checks come from
// requests-model.js (pure, tested by tests/requests_test.mjs). Everything is live: Firestore listeners,
// one per week however many readers (the page + the nav badge), dropped when nobody reads it.
import { html } from '../preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { setState, toast } from '../store.js';
import { Banner, Spinner } from '../ui.js';
import { canLive, canTimeoff, watchTimeoff, saveTimeoff, clearTimeoff, liveWeeks, liveWeek, watchLiveWeek,
  watchLiveSummary, canWatchSummary, canOffers } from '../api.js';
import { loadDriverRoster } from '../lib/driver-prefs.js';
import { toISODate } from '../lib/weeks.js';
import { useOffers, useTakes, OfferForm } from './offers.js';
import { dayLabel, takeStatus, offerDays } from './offers-model.js';
import { fold, shiftISO, sundayOf, rangeOf, weeksBetween, askedLabel, requestRows, groupByDay, conflictsOf,
  offerLists, offerRole, offerLine, takeTone } from './requests-model.js';

const AHEAD = 12;   // weeks past this one a day off can be added for, as on Driver preferences
const todayNow = () => toISODate(new Date());
const openLive = () => setState({ route: 'live' });

// A published week's summary, parsed, kept current: cb(summary | null = not published / unreadable).
function watchSummary(week, cb) {
  if (canWatchSummary()) {
    let rev;
    return watchLiveSummary(week, (doc) => {
      if (!doc || typeof doc.json !== 'string') { rev = undefined; cb(null); return; }
      if (rev !== undefined && doc.rev === rev) return;
      rev = doc.rev;
      try { cb(JSON.parse(doc.json)); } catch { cb(null); }
    });
  }
  // an older jajb.js (no generic watch): the week doc, then the saved week on each change
  let dead = false;
  const un = watchLiveWeek(week, (m) => {
    if (!m) { cb(null); return; }
    liveWeek(week).then((d) => { if (!dead) cb(d && d.summary ? JSON.parse(d.summary) : null); })
      .catch(() => { if (!dead) cb(null); });
  });
  return () => { dead = true; un(); };
}

// One week's days off + Live summary, shared and refcounted (like offers.js takeFeeds).
const weekFeeds = new Map();   // week -> {off, sm, subs, uns}
function subWeek(week, fn) {
  let f = weekFeeds.get(week);
  if (!f) {
    f = { off: undefined, sm: undefined, subs: new Set(), uns: [] };
    weekFeeds.set(week, f);
    const push = () => f.subs.forEach((s) => s(week, f));
    // null = the read failed (not "nobody asked off")
    f.uns.push(watchTimeoff(week, (d) => { f.off = d && typeof d === 'object' ? d : null; push(); }));
    f.uns.push(watchSummary(week, (sm) => { f.sm = sm; push(); }));
  }
  f.subs.add(fn);
  fn(week, f);
  return () => {
    f.subs.delete(fn);
    if (!f.subs.size) { weekFeeds.delete(week); f.uns.forEach((u) => u()); }
  };
}
// {off: {week: days off}, sm: {week: summary}} for these weeks (as requests-model.js reads them)
function useWeeks(weeks) {
  const [st, setSt] = useState({ off: {}, sm: {} });
  const key = weeks.join(',');
  useEffect(() => {
    if (!weeks.length) return undefined;
    const uns = weeks.map((w) => subWeek(w, (wk, f) => setSt((s) => (s.off[wk] === f.off && s.sm[wk] === f.sm
      ? s : { off: { ...s.off, [wk]: f.off }, sm: { ...s.sm, [wk]: f.sm } }))));
    return () => uns.forEach((u) => u());
  }, [key]);
  return st;
}

// The nav badge: how many drivers asked off in the next 14 days but are still on the Live schedule.
export function useConflictCount() {
  const today = todayNow();
  const { from, to } = rangeOf(today, 'next');
  const st = useWeeks(canLive() && canTimeoff() ? weeksBetween(from, to) : []);
  return conflictsOf(st.off, st.sm, today).drivers;
}

// "+ Add a day off": a driver (the roster, or any typed name, as on Driver preferences), a date, a note.
// Same checks as Driver preferences: from today to 12 weeks out, and only for a week not built yet.
function AddDayOff({ onDone }) {
  const today = todayNow();
  const maxDay = shiftISO(sundayOf(today), 7 * AHEAD + 6);
  const [names, setNames] = useState([]);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const built = useRef(null);                   // Promise<Set of published week Sundays>
  useEffect(() => {
    built.current = Promise.resolve(liveWeeks(80)).then((ws) => new Set((ws || []).map((w) => w && w.week)));
    built.current.catch(() => {});
    loadDriverRoster({ active: true }).then((r) => { if (alive.current) setNames((r || []).map((x) => x.name)); }).catch(() => {});
    return () => { alive.current = false; };
  }, []);

  const add = async (e) => {
    if (e) e.preventDefault();
    setMsg('');
    const typed = name.trim();
    if (!typed) { setMsg('Pick a driver first.'); return; }
    if (!date) { setMsg('Pick a date first.'); return; }
    if (date < today || date > maxDay) { setMsg(`Pick a date from ${dayLabel(today)} to ${dayLabel(maxDay)}.`); return; }
    const who = names.find((n) => fold(n) === fold(typed)) || typed;
    const week = sundayOf(date);
    setBusy(true);
    try {
      let pub;
      try { pub = await built.current; } catch { setMsg("Couldn't check which weeks are built — check the connection."); return; }
      if (pub.has(week)) { setMsg('That week is already built — mark the day off on the Live schedule instead.'); return; }
      await saveTimeoff(week, who, date, note.trim().slice(0, 300));
      if (!alive.current) return;
      toast('Day off added');
      onDone();
    } catch {
      toast("Couldn't save — check your connection and try again.", 'err');
    } finally { if (alive.current) setBusy(false); }
  };

  return html`<form class="rq-add" onSubmit=${add}>
    <div class="row rq-add-row">
      <label class="fld"><span>Driver</span>
        <input type="text" list="rq-names" value=${name} disabled=${busy} placeholder="Full name" autocomplete="off"
          onInput=${(e) => { setName(e.target.value); setMsg(''); }} /></label>
      <datalist id="rq-names">${names.map((n) => html`<option value=${n} />`)}</datalist>
      <label class="fld"><span>Date</span>
        <input type="date" min=${today} max=${maxDay} value=${date} disabled=${busy}
          onInput=${(e) => { setDate(e.target.value); setMsg(''); }} /></label>
      <label class="fld rq-add-note"><span>Note (optional)</span>
        <input type="text" maxLength="300" placeholder="Doctor visit" value=${note} disabled=${busy}
          onInput=${(e) => setNote(e.target.value)} /></label>
    </div>
    ${msg ? html`<div class="small dv-dl-msg" role="alert">${msg}</div>` : ''}
    <div class="row">
      <button class="primary small" disabled=${busy}>${busy ? 'Saving…' : 'Add day off'}</button>
      <button type="button" class="small" disabled=${busy} onClick=${onDone}>Cancel</button>
    </div>
    <div class="hint" style="margin-bottom:0">Only for weeks not built yet — the build turns it into an Unavailable day. A built week: mark the day off on the Live schedule.</div>
  </form>`;
}

const STATUS = {
  scheduled: (s) => ({ cls: 'bad', text: `still scheduled ${s.what}` }),
  off: () => ({ cls: 'ok', text: 'off ✓' }),
  unbuilt: () => ({ cls: 'na', text: 'the build will use it' }),
  loading: () => ({ cls: 'na', text: '…' }),
};

function DaysOffCard({ st, today }) {
  const [range, setRange] = useState('next');
  const [source, setSource] = useState('all');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');          // the row being removed
  if (!canTimeoff()) {
    return html`<div class="card rq-card"><h2>Days off asked for</h2>
      <p class="muted" style="margin:0">Days off need the JAJB hub's connection — open the Schedule Builder from the hub.</p></div>`;
  }
  const { from, to } = rangeOf(today, range);
  const weeks = weeksBetween(from, to);
  const loading = weeks.some((w) => st.off[w] === undefined);
  const failed = weeks.some((w) => st.off[w] === null);
  const groups = groupByDay(requestRows(st.off, st.sm, { from, to, source }), st.sm, today, range === 'past');

  const remove = async (r, label) => {
    if (!window.confirm(`Remove ${r.name}'s day off on ${label}?${r.src.app ? ' They asked for it in the drivers\' app.' : ''}`)) return;
    setBusy(r.key);
    try { await clearTimeoff(r.week, r.name, r.day); toast('Day off removed'); }
    catch { toast("Couldn't remove it — check your connection and try again.", 'err'); }
    setBusy('');
  };
  const seg = (val, set, opts, label) => html`<div class="seg" role="group" aria-label=${label}>
    ${opts.map(([k, t]) => html`<button class=${val === k ? 'on' : ''} aria-pressed=${val === k} onClick=${() => set(k)}>${t}</button>`)}
  </div>`;

  return html`<div class="card rq-card">
    <div class="rq-head"><h2>Days off asked for</h2>
      ${adding ? '' : html`<button class="small" onClick=${() => setAdding(true)}>+ Add a day off</button>`}</div>
    ${adding ? html`<${AddDayOff} onDone=${() => setAdding(false)} />` : ''}
    <div class="row rq-filters">
      ${seg(range, setRange, [['next', 'Next 14 days'], ['past', 'Past 14 days']], 'Dates')}
      ${seg(source, setSource, [['all', 'All'], ['app', 'Driver app'], ['office', 'Added by a manager']], 'Who added it')}
    </div>
    ${failed ? html`<p class="muted small">Couldn't load every week's days off — check the connection.</p>` : ''}
    ${groups.length ? groups.map((g) => html`<div class="rq-day" key=${g.date}>
      <div class="rq-dayh">${g.label} · ${g.n} off${g.unbuilt ? ` · ${g.unbuilt}` : ''}</div>
      <ul class="rq-list">${g.rows.map((r) => {
        const s = STATUS[r.status.state](r.status);
        const asked = askedLabel(r.at);
        return html`<li class="rq-row" key=${r.key}>
          <div class="rq-who">
            <b>${r.name}</b>
            <span class=${'chip ' + (r.src.app ? 'blue' : 'gray')}>${r.src.label}</span>
            ${r.note ? html`<span class="muted rq-note">“${r.note}”</span>` : ''}
            ${asked ? html`<span class="muted rq-asked">${asked}</span>` : ''}
          </div>
          <span class=${'rq-st ' + s.cls}>${s.text}</span>
          <button class="ghost rq-x" title="Remove this day off" aria-label=${`Remove ${r.name}'s day off on ${g.label}`}
            disabled=${!!busy} onClick=${() => remove(r, g.label)}>✕</button>
        </li>`;
      })}</ul>
    </div>`)
      : loading ? html`<p class="muted"><${Spinner}/> Loading…</p>`
      : html`<p class="muted" style="margin:0">No days off asked for in the ${range === 'past' ? 'past' : 'next'} 14 days.</p>`}
  </div>`;
}

const lc1 = (s) => String(s || '').charAt(0).toLowerCase() + String(s || '').slice(1);

// One offer: VET / VTO, the day, the role + wave; taken / status / how it's decided; who took it.
function OfferCard({ o }) {
  const takes = useTakes(o.id);
  return html`<div class="rq-offer">
    <div class="rq-of1"><span class=${'chip ' + (o.kind === 'vto' ? 'amber' : 'green')}>${o.kind === 'vto' ? 'VTO' : 'VET'}</span>
      <b>${dayLabel(o.date)}</b><span>${offerRole(o)}</span></div>
    <div class="muted rq-of2">${offerLine(o, takes)}</div>
    ${Array.isArray(takes) && takes.length ? html`<div class="rq-of3">${takes.map((t, i) => html`${i ? ' · ' : ''}<span class="rq-taker">${t.name || t.tid}${' '}<span
      class=${'rq-tk ' + takeTone(t)}>${lc1(takeStatus(t, o).text)}</span></span>`)}</div>` : ''}
  </div>`;
}

// days = the published weeks' days (the Live board's view.days shape) the offer form can post for
function OffersCard({ days, today }) {
  const rows = useOffers();
  const [posting, setPosting] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  if (!canOffers()) {
    return html`<div class="card rq-card"><h2>VET / VTO offers</h2>
      <p class="muted" style="margin:0">VET / VTO offers aren't available on this connection.</p></div>`;
  }
  // the Live board's own form when a published day is left to post for; else the Live schedule
  const canPost = offerDays(days, today).length > 0;
  const { open, closed } = offerLists(rows, today);
  return html`<div class="card rq-card">
    <div class="rq-head"><h2>VET / VTO offers</h2>
      ${posting ? '' : html`<button class="small" onClick=${() => (canPost ? setPosting(true) : openLive())}>Post an offer</button>`}</div>
    ${posting ? html`<div class="rq-form"><${OfferForm} days=${days} today=${today} date=${today} uid="rq"
      onDone=${() => setPosting(false)} onCancel=${() => setPosting(false)} /></div>` : ''}
    ${rows === undefined ? html`<p class="muted"><${Spinner}/> Loading…</p>`
      : rows === null ? html`<p class="muted" style="margin:0">Could not read the VET / VTO offers.</p>`
      : html`
        ${open.length ? html`<div class="rq-offers">${open.map((o) => html`<${OfferCard} o=${o} key=${o.id} />`)}</div>`
          : html`<p class="muted">No open offers.</p>`}
        ${closed.length ? html`<button class="link rq-more" aria-expanded=${showClosed} onClick=${() => setShowClosed((v) => !v)}>
          Closed / past offers ${showClosed ? '▾' : '▸'}</button>
          ${showClosed ? html`<div class="rq-offers rq-closed">${closed.map((o) => html`<${OfferCard} o=${o} key=${o.id} />`)}</div>` : ''}` : ''}`}
  </div>`;
}

export function Requests() {
  const today = todayNow();
  // the weeks both ranges touch: the past 14 days and the next 14 (the alert + the offer form use the next ones)
  const weeks = weeksBetween(shiftISO(today, -14), shiftISO(today, 13));
  const st = useWeeks(canLive() ? weeks : []);
  const c = conflictsOf(st.off, st.sm, today);
  const nextWeeks = weeksBetween(today, shiftISO(today, 13));
  const days = nextWeeks.flatMap((w) => (st.sm[w] && Array.isArray(st.sm[w].days) ? st.sm[w].days : []));

  if (!canLive()) return html`<${Banner} kind="info">Requests need the JAJB hub's connection — open the Schedule Builder from the hub.<//>`;
  return html`<div class="rq">
    ${c.drivers ? html`<div class="card rq-alert" role="alert">
      <b>${c.drivers} driver${c.drivers === 1 ? '' : 's'} asked off but ${c.drivers === 1 ? 'is' : 'are'} still on the schedule —</b>
      ${c.groups.map((g) => html`<button class="link rq-alert-it" title="Open the Live schedule" onClick=${openLive}>${g.label}: ${g.names.join(', ')}</button>`)}
    </div>` : ''}
    <div class="rq-cols">
      <${DaysOffCard} st=${st} today=${today} />
      <${OffersCard} days=${days} today=${today} />
    </div>
  </div>`;
}

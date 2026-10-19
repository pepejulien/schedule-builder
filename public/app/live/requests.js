// The Requests page (Jose 2026-10-19: it replaces the Today page, which nobody used — the Live
// schedule is the landing page now). A month calendar like Paycom's time-off calendar: each day
// shows the days off asked for (schedule_timeoff, from the drivers' app or typed in by a manager),
// who asked off but is still on the published Live schedule, VET / VTO takes waiting for an answer,
// and that day's VET / VTO offers; clicking a day opens it in the panel beside the calendar. A red
// line on top names whoever asked off in the next 14 days but is still on the schedule; the nav's
// Requests item carries the same count (useConflictCount). The words and the counts come from
// requests-model.js (pure, tested by tests/requests_test.mjs). Everything is live: Firestore
// listeners, one per week however many readers (the page + the nav badge), dropped when nobody reads it.
import { html } from '../preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { setState, toast } from '../store.js';
import { Banner, Spinner } from '../ui.js';
import { canLive, canTimeoff, watchTimeoff, saveTimeoff, clearTimeoff, liveWeeks, liveWeek, watchLiveWeek,
  watchLiveSummary, canWatchSummary, canOffers, watchOffers } from '../api.js';
import { loadDriverRoster } from '../lib/driver-prefs.js';
import { toISODate } from '../lib/weeks.js';
import { useTakes, useTakesMap, OfferForm } from './offers.js';
import { dayLabel, takeStatus, offerDays } from './offers-model.js';
import { fold, shiftISO, sundayOf, rangeOf, weeksBetween, askedLabel, conflictsOf, offerRole, offerLine, takeTone,
  monthOf, shiftMonth, longDate, monthGrid, dayViews } from './requests-model.js';

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

// One listener per key (a week) however many readers, dropped when nobody reads it (like offers.js takeFeeds).
function makeFeed(watch) {
  const feeds = new Map();                       // key -> {val, subs, un}
  return (key, fn) => {
    let f = feeds.get(key);
    if (!f) {
      f = { val: undefined, subs: new Set(), un: null };
      feeds.set(key, f);
      f.un = watch(key, (v) => { f.val = v; f.subs.forEach((s) => s(v)); });
    }
    f.subs.add(fn);
    fn(f.val);
    return () => {
      f.subs.delete(fn);
      if (!f.subs.size) { feeds.delete(key); if (f.un) f.un(); }
    };
  };
}
// days off (null = the read failed, not "nobody asked off"), the Live summary, the week's VET / VTO offers
const subOff = makeFeed((week, cb) => watchTimeoff(week, (d) => cb(d && typeof d === 'object' ? d : null)));
const subSm = makeFeed(watchSummary);
const subOffers = makeFeed((week, cb) => watchOffers(week, cb));
// {key: value} for these keys (undefined = not read yet); a key dropped from the list stops its listener
function useFeed(sub, keys) {
  const [map, setMap] = useState({});
  const key = keys.join(',');
  useEffect(() => {
    if (!keys.length) return undefined;
    const uns = keys.map((k) => sub(k, (v) => setMap((m) => (k in m && m[k] === v ? m : { ...m, [k]: v }))));
    return () => uns.forEach((u) => u());
  }, [key]);
  return map;
}

// The nav badge: how many drivers asked off in the next 14 days but are still on the Live schedule.
export function useConflictCount() {
  const today = todayNow();
  const { from, to } = rangeOf(today, 'next');
  const weeks = canLive() && canTimeoff() ? weeksBetween(from, to) : [];
  const off = useFeed(subOff, weeks), sm = useFeed(subSm, weeks);
  return conflictsOf(off, sm, today).drivers;
}

// "+ Add a day off": a driver (the roster, or any typed name, as on Driver preferences), a date, a note.
// Same checks as Driver preferences: from today to 12 weeks out, and only for a week not built yet.
function AddDayOff({ date: date0, names, onDone }) {
  const today = todayNow();
  const maxDay = shiftISO(sundayOf(today), 7 * AHEAD + 6);
  const [name, setName] = useState('');
  const [date, setDate] = useState(date0 || '');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const built = useRef(null);                   // Promise<Set of published week Sundays>
  useEffect(() => {
    built.current = Promise.resolve(liveWeeks(80)).then((ws) => new Set((ws || []).map((w) => w && w.week)));
    built.current.catch(() => {});
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

// One day off: name, who put it in, the note, when; its status against the Live schedule; ✕ remove.
function OffRow({ r, label }) {
  const [busy, setBusy] = useState(false);
  const s = STATUS[r.status.state](r.status);
  const asked = askedLabel(r.at);
  const remove = async () => {
    if (!window.confirm(`Remove ${r.name}'s day off on ${label}?${r.src.app ? ' They asked for it in the drivers\' app.' : ''}`)) return;
    setBusy(true);
    try { await clearTimeoff(r.week, r.name, r.day); toast('Day off removed'); }
    catch { toast("Couldn't remove it — check your connection and try again.", 'err'); setBusy(false); }
  };
  return html`<li class="rq-row">
    <div class="rq-who">
      <b>${r.name}</b>
      <span class=${'chip ' + (r.src.app ? 'blue' : 'gray')}>${r.src.label}</span>
      ${r.note ? html`<span class="muted rq-note">“${r.note}”</span>` : ''}
      ${asked ? html`<span class="muted rq-asked">${asked}</span>` : ''}
    </div>
    <span class=${'rq-st ' + s.cls}>${s.text}</span>
    <button class="ghost rq-x" title="Remove this day off" aria-label=${`Remove ${r.name}'s day off on ${label}`}
      disabled=${busy} onClick=${remove}>✕</button>
  </li>`;
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

const SHOW = [['all', 'All'], ['off', 'Days off'], ['vet', 'VET'], ['vto', 'VTO']];

// Show: All / Days off / VET / VTO · Driver: everyone, or one (type to search the roster).
function FilterCard({ show, setShow, driver, setDriver }) {
  return html`<div class="card rq-filter">
    <div class="rq-fld"><span class="rq-lab">Show</span>
      <div class="seg" role="group" aria-label="Show">
        ${SHOW.map(([k, t]) => html`<button class=${show === k ? 'on' : ''} aria-pressed=${show === k} onClick=${() => setShow(k)}>${t}</button>`)}
      </div></div>
    <div class="rq-fld"><span class="rq-lab">Driver</span>
      <input type="text" class="rq-drv" list="rq-names" placeholder="All drivers" value=${driver} autocomplete="off"
        aria-label="Driver" onInput=${(e) => setDriver(e.target.value)} />
      ${driver ? html`<button class="small ghost" onClick=${() => setDriver('')}>All drivers</button>` : ''}</div>
  </div>`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_CHIPS = 3;

function CalendarCard({ grid, views, today, sel, onPick, onMonth, onToday, loading }) {
  return html`<div class="card rq-calcard">
    <div class="rq-calhead"><h2>${grid.label}</h2>
      ${loading ? html`<${Spinner}/>` : ''}
      <div class="row rq-calnav">
        <button class="small" onClick=${onToday}>Today</button>
        <button class="small" aria-label="Previous month" onClick=${() => onMonth(-1)}>‹</button>
        <button class="small" aria-label="Next month" onClick=${() => onMonth(1)}>›</button>
      </div></div>
    <div class="rq-cal" role="grid" aria-label=${grid.label}>
      ${DOW.map((d) => html`<div class="rq-dow" role="columnheader">${d}</div>`)}
      ${grid.cells.map((c) => {
        const v = views[c.date] || { chips: [] };
        const more = v.chips.length - MAX_CHIPS;
        return html`<button key=${c.date} role="gridcell" aria-selected=${c.date === sel}
          class=${'rq-cell' + (c.inMonth ? '' : ' out') + (c.date === today ? ' today' : '') + (c.date === sel ? ' sel' : '')}
          aria-label=${`${longDate(c.date)}${v.chips.length ? ': ' + v.chips.map((x) => x.text).join(', ') : ''}`}
          onClick=${() => onPick(c.date)}>
          <span class="rq-num">${c.num}</span>
          ${v.chips.slice(0, MAX_CHIPS).map((x) => html`<span class=${'rq-chip ' + x.kind + (x.faded ? ' faded' : '')}>${x.text}</span>`)}
          ${more > 0 ? html`<span class="rq-moretxt">+${more} more</span>` : ''}
        </button>`;
      })}
    </div>
  </div>`;
}

function LegendCard() {
  const items = [['off', 'Days off'], ['conflict', 'Still scheduled'], ['pending', 'Pending'], ['vet', 'VET'], ['vto', 'VTO']];
  return html`<div class="card rq-legend">
    ${items.map(([k, t]) => html`<span class="rq-leg"><span class=${'rq-chip rq-sw ' + k}></span>${t}</span>`)}
  </div>`;
}

// The picked day: its days off and its VET / VTO, "+ Add a day off" (that date) and "Post an offer"
// (that date when it can still be posted for — the Live board's own form; else the Live schedule).
function DayPanel({ date, view, days, today, names, show }) {
  const [adding, setAdding] = useState(false);
  const [posting, setPosting] = useState(false);
  const label = dayLabel(date);
  const postable = canOffers() ? offerDays(days, today) : [];
  const post = () => { setAdding(false); if (postable.length) setPosting(true); else openLive(); };
  const nothing = !view.offs.length && !view.offers.length;
  return html`<div class="card rq-panel">
    <h2>${longDate(date)}</h2>
    <div class="row rq-panelbtns">
      ${canTimeoff() && !adding ? html`<button class="small" onClick=${() => { setAdding(true); setPosting(false); }}>+ Add a day off</button>` : ''}
      ${canOffers() && !posting ? html`<button class="small" onClick=${post}>Post an offer</button>` : ''}
    </div>
    ${adding ? html`<${AddDayOff} date=${date} names=${names} onDone=${() => setAdding(false)} />` : ''}
    ${posting ? html`<div class="rq-form"><${OfferForm} days=${days} today=${today}
      date=${postable.some((x) => x.date === date) ? date : today} uid="rq"
      onDone=${() => setPosting(false)} onCancel=${() => setPosting(false)} /></div>` : ''}
    ${!canTimeoff() && show !== 'vet' && show !== 'vto' ? html`<p class="muted">Days off need the JAJB hub's connection — open the Schedule Builder from the hub.</p>` : ''}
    ${nothing ? html`<p class="muted" style="margin:0">Nothing asked for this day.</p>` : ''}
    ${view.offs.length ? html`<h3>Days off (${view.offs.length})</h3>
      <ul class="rq-list">${view.offs.map((r) => html`<${OffRow} r=${r} label=${label} key=${r.key} />`)}</ul>` : ''}
    ${view.offers.length ? html`<h3>VET / VTO</h3>
      <div class="rq-offers">${view.offers.map((o) => html`<${OfferCard} o=${o} key=${o.id} />`)}</div>` : ''}
  </div>`;
}

export function Requests() {
  const today = todayNow();
  const [ym, setYm] = useState(() => monthOf(today));
  const [sel, setSel] = useState(today);
  const [show, setShow] = useState('all');
  const [driver, setDriver] = useState('');
  const [roster, setRoster] = useState([]);
  useEffect(() => {
    let alive = true;
    if (canLive()) loadDriverRoster({ active: true }).then((r) => { if (alive) setRoster((r || []).map((x) => x.name)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const grid = monthGrid(ym);
  // the visible month's 6 weeks, the picked day's week, and the next 14 days (the alert + the offer form)
  const weeks = canLive() ? [...new Set([...grid.weeks, sundayOf(sel), ...weeksBetween(today, shiftISO(today, 13))])].sort() : [];
  const off = useFeed(subOff, weeks);
  const sm = useFeed(subSm, weeks);
  const offerWeeks = useFeed(subOffers, canOffers() ? weeks : []);
  const offers = weeks.flatMap((w) => (Array.isArray(offerWeeks[w]) ? offerWeeks[w] : []));
  const takesById = useTakesMap(offers.map((o) => o.id).sort());

  if (!canLive()) return html`<${Banner} kind="info">Requests need the JAJB hub's connection — open the Schedule Builder from the hub.<//>`;

  const src = { offByWeek: off, smByWeek: sm, offers, takesById };
  const filter = { show, driver };
  const first = grid.cells[0].date, last = grid.cells[41].date;
  const views = dayViews(first, last, src, filter);
  const selView = (sel >= first && sel <= last ? views : dayViews(sel, sel, src, filter))[sel];
  const c = conflictsOf(off, sm, today);
  const loading = grid.weeks.some((w) => (canTimeoff() && off[w] === undefined) || (canOffers() && offerWeeks[w] === undefined));
  const failed = grid.weeks.some((w) => off[w] === null || offerWeeks[w] === null);
  // the offer form's days: the published days of the next 14 days (the Live board's view.days shape)
  const days = weeksBetween(today, shiftISO(today, 13)).flatMap((w) => (sm[w] && Array.isArray(sm[w].days) ? sm[w].days : []));
  // the driver search list: the roster + anyone named in the loaded days off / takes
  const names = [...new Set([...roster,
    ...Object.values(off).flatMap((d) => Object.values(d || {}).map((t) => t && t.name)),
    ...Object.values(takesById).flatMap((t) => (Array.isArray(t) ? t.map((x) => x && x.name) : []))].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const pick = (d) => { setSel(d); if (monthOf(d) !== ym) setYm(monthOf(d)); };

  return html`<div class="rq">
    ${c.drivers ? html`<div class="card rq-alert" role="alert">
      <b>${c.drivers} driver${c.drivers === 1 ? '' : 's'} asked off but ${c.drivers === 1 ? 'is' : 'are'} still on the schedule —</b>
      ${c.groups.map((g) => html`<button class="link rq-alert-it" title="Open the Live schedule" onClick=${openLive}>${g.label}: ${g.names.join(', ')}</button>`)}
    </div>` : ''}
    <datalist id="rq-names">${names.map((n) => html`<option value=${n} />`)}</datalist>
    <div class="rq-layout">
      <div class="rq-left">
        <${FilterCard} show=${show} setShow=${setShow} driver=${driver} setDriver=${setDriver} />
        ${failed ? html`<${Banner} kind="warn">Couldn't load everything for this month — check the connection.<//>` : ''}
        <${CalendarCard} grid=${grid} views=${views} today=${today} sel=${sel} loading=${loading}
          onPick=${pick} onMonth=${(n) => setYm((m) => shiftMonth(m, n))} onToday=${() => { setYm(monthOf(today)); setSel(today); }} />
        <${LegendCard} />
      </div>
      <div class="rq-right">
        <${DayPanel} key=${sel} date=${sel} view=${selView} days=${days} today=${today} names=${names} show=${show} />
      </div>
    </div>
  </div>`;
}

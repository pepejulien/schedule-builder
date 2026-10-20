// The Requests page (Jose 2026-10-19: it replaces the Today page, which nobody used — the Live
// schedule is the landing page now). A month calendar like Paycom's time-off calendar: each day
// shows the days off asked for (schedule_timeoff, from the drivers' app or typed in by a manager),
// who asked off but is still on the published Live schedule, what waits for an answer (day-off reviews:
// a day the Driver app refused that the driver sent for review, 2026-10-19 — and VET / VTO takes), and
// that day's VET / VTO offers; clicking a day opens it in the panel beside the calendar, where reviews
// are approved or denied. A red line on top names whoever asked off in the next 14 days but is still on
// the schedule, and the reviews waiting; the nav's Requests item counts both (useConflictCount).
// #requests / #requests/YYYY-MM-DD (the HR notification's link) opens this page on that day (app.js). The words and the counts come from
// requests-model.js (pure, tested by tests/requests_test.mjs). Everything is live: Firestore
// listeners, one per week however many readers (the page + the nav badge), dropped when nobody reads it.
import { html } from '../preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { setState, toast, useStore } from '../store.js';
import { Banner, Spinner } from '../ui.js';
import { canLive, canTimeoff, watchTimeoff, saveTimeoff, clearTimeoff, liveWeeks, liveWeek, watchLiveWeek,
  watchLiveSummary, canWatchSummary, canOffers, watchOffers, canReviews, watchReviews, decideReview,
  canBlocks, watchBlocked, blockDay, unblockDay } from '../api.js';
import { loadDriverRoster, loadDriverPrefs } from '../lib/driver-prefs.js';
import { toISODate } from '../lib/weeks.js';
import { useTakes, useTakesMap, OfferForm } from './offers.js';
import { dayLabel, takeStatus, offerDays } from './offers-model.js';
import { fold, shiftISO, sundayOf, rangeOf, weeksBetween, askedLabel, conflictsOf, offerRole, offerLine, takeTone,
  monthOf, shiftMonth, longDate, monthGrid, dayViews, refusedText, reviewsWaiting, applyProblem, denyReason,
  reviewActions, CALL_OFF_WHY, BLOCKED_WARN, BLOCK_REASON_MAX, blockReason, blockedOf, offMode, bothLine } from './requests-model.js';

// "Off counts:" Requested / Weekly preference / Both (Jose 2026-10-19): remembered per browser (default
// Requested; storage blocked = Requested)
const OFFC_KEY = 'sb.rq.offcounts';
const readOffMode = () => { try { return offMode(localStorage.getItem(OFFC_KEY)); } catch { return 'requested'; } };
const saveOffMode = (m) => { try { localStorage.setItem(OFFC_KEY, m); } catch { /* not remembered */ } };
const OFF_MODE_LABELS = [['requested', 'Requested'], ['weekly', 'Weekly preference'], ['both', 'Both']];

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
// day-off reviews for a day range: key "from|to" ('' = no bound)
const subReviews = makeFeed((key, cb) => { const [f, t] = key.split('|'); return watchReviews(f || null, t || null, cb); });
// blocked days for a day range: key "from|to" -> {day: entry} | null (read failed)
const subBlocked = makeFeed((key, cb) => { const [f, t] = key.split('|'); return watchBlocked(f || null, t || null, cb); });
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

// The nav badge: what needs an answer — drivers who asked off in the next 14 days but are still on the
// Live schedule, plus the day-off reviews waiting (from today on).
export function useConflictCount() {
  const today = todayNow();
  const { from, to } = rangeOf(today, 'next');
  const weeks = canLive() && canTimeoff() ? weeksBetween(from, to) : [];
  const off = useFeed(subOff, weeks), sm = useFeed(subSm, weeks);
  const rk = `${today}|`;
  const rv = useFeed(subReviews, canLive() && canReviews() ? [rk] : []);
  return conflictsOf(off, sm, today, rv[rk]).drivers + reviewsWaiting(rv[rk], today).n;
}

// "+ Add a day off": a driver (the roster, or any typed name, as on Driver preferences), a date, a note.
// Same checks as Driver preferences: from today to 12 weeks out, and only for a week not built yet.
function AddDayOff({ date: date0, names, onDone, blocked }) {
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
    ${date && blockedOf(blocked, date) ? html`<div class="small rq-blockwarn">${BLOCKED_WARN}</div>` : ''}
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
// From an approved review: "approved by <name>", and a red line when it couldn't go on the schedule
// (a day put on the Live week by the review has no schedule_timeoff doc: nothing to remove here).
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
      ${r.approvedBy ? html`<span class="muted rq-asked">approved by ${r.approvedBy}</span>` : ''}
    </div>
    <span class=${'rq-st ' + s.cls}>${s.text}</span>
    ${r.fromReview ? html`<span class="rq-x-space"></span>` : html`<button class="ghost rq-x" title="Remove this day off" aria-label=${`Remove ${r.name}'s day off on ${label}`}
      disabled=${busy} onClick=${remove}>✕</button>`}
    ${r.review && applyProblem(r.review) ? html`<div class="rq-bad">${applyProblem(r.review)}</div>` : ''}
  </li>`;
}

// A day-off review waiting: who, why the app said no, their note, when; scheduled that day? Approve / Deny…
// (a reason, required — the driver sees it). Its week already published (Jose 2026-10-19): no Approve — the note
// "Week already published — it's a call-off now" and only "Close it" (= deny with the call-off reason).
function ReviewRow({ r }) {
  const [busy, setBusy] = useState(false);
  const [denying, setDenying] = useState(false);
  const [why, setWhy] = useState('');
  const [err, setErr] = useState('');
  const asked = askedLabel(r.at);
  const can = reviewActions(r);
  const decide = async (decision, reason, closing = false) => {
    setBusy(true); setErr('');
    try {
      await decideReview(r.id, decision, reason);
      toast(closing ? 'Closed — the driver is told to call off instead.'
        : decision === 'approved' ? `Approved — ${r.name}'s day off goes on the schedule in a moment.` : 'Denied — the driver sees your reason.');
    } catch (e) {
      setErr(`Couldn't save the answer: ${e.message || e}`);
      setBusy(false);
    }
  };
  const deny = (e) => {
    if (e) e.preventDefault();
    const d = denyReason(why);
    if (d.error) { setErr(d.error); return; }
    decide('denied', d.why);
  };
  return html`<li class="rq-row rq-review">
    <div class="rq-who">
      <b>${r.name}</b>
      <span class="chip blue">Driver app</span>
      <span class="rq-refused">${refusedText(r)}</span>
      ${r.note ? html`<span class="muted rq-note">“${r.note}”</span>` : ''}
      ${asked ? html`<span class="muted rq-asked">${asked}</span>` : ''}
      ${r.live && r.live.state === 'scheduled' ? html`<span class="muted rq-asked">scheduled ${r.live.what}</span>` : ''}
      ${can.note ? html`<div class="rq-bad">${can.note}</div>` : ''}
      ${denying && can.deny ? html`<form class="rq-deny" onSubmit=${deny}>
        <input type="text" maxLength="200" value=${why} disabled=${busy} placeholder="Reason" aria-label="Reason for the driver"
          onInput=${(e) => { setWhy(e.target.value); setErr(''); }} />
        <div class="hint">The driver sees this reason — don't name anyone.</div>
        <div class="row"><button class="small" disabled=${busy}>Deny</button>
          <button type="button" class="small ghost" disabled=${busy} onClick=${() => { setDenying(false); setErr(''); }}>Cancel</button></div>
      </form>` : ''}
      ${err ? html`<div class="rq-bad" role="alert">${err}</div>` : ''}
    </div>
    ${denying && can.deny ? '' : html`<div class="row rq-revbtns">
      ${can.approve ? html`<button class="primary small" disabled=${busy} onClick=${() => decide('approved', '')}>Approve</button>` : ''}
      ${can.deny ? html`<button class="small" disabled=${busy} onClick=${() => setDenying(true)}>Deny…</button>` : ''}
      ${can.close ? html`<button class="small" disabled=${busy} title="Deny it: the driver reads that the schedule is out and to call off"
        onClick=${() => decide('denied', CALL_OFF_WHY, true)}>Close it</button>` : ''}
    </div>`}
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

// Show: All / Days off / VET / VTO · Driver: everyone, or one (type to search the roster) · Off counts:
// Requested / Weekly preference / Both (what the calendar's off chip counts).
function FilterCard({ show, setShow, driver, setDriver, mode, setMode }) {
  return html`<div class="card rq-filter">
    <div class="rq-fld"><span class="rq-lab">Show</span>
      <div class="seg" role="group" aria-label="Show">
        ${SHOW.map(([k, t]) => html`<button class=${show === k ? 'on' : ''} aria-pressed=${show === k} onClick=${() => setShow(k)}>${t}</button>`)}
      </div></div>
    <div class="rq-fld"><span class="rq-lab">Driver</span>
      <input type="text" class="rq-drv" list="rq-names" placeholder="All drivers" value=${driver} autocomplete="off"
        aria-label="Driver" onInput=${(e) => setDriver(e.target.value)} />
      ${driver ? html`<button class="small ghost" onClick=${() => setDriver('')}>All drivers</button>` : ''}</div>
    <div class="rq-fld"><span class="rq-lab">Off counts:</span>
      <div class="seg" role="group" aria-label="Off counts">
        ${OFF_MODE_LABELS.map(([k, t]) => html`<button class=${mode === k ? 'on' : ''} aria-pressed=${mode === k} onClick=${() => setMode(k)}>${t}</button>`)}
      </div></div>
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
          class=${'rq-cell' + (c.inMonth ? '' : ' out') + (c.date === today ? ' today' : '') + (c.date === sel ? ' sel' : '') + (v.blocked ? ' blocked' : '')}
          aria-label=${`${longDate(c.date)}${v.chips.length ? ': ' + v.chips.map((x) => x.long || x.text).join(', ') : ''}`}
          onClick=${() => onPick(c.date)}>
          <span class="rq-num">${c.num}</span>
          ${v.chips.slice(0, MAX_CHIPS).map((x) => html`<span class=${'rq-chip ' + x.kind + (x.faded ? ' faded' : '')} title=${x.title}>${x.text}</span>`)}
          ${more > 0 ? html`<span class="rq-moretxt">+${more} more</span>` : ''}
        </button>`;
      })}
    </div>
  </div>`;
}

// the off-count chip of each "Off counts" mode, in the legend
const MODE_LEGEND = { requested: ['off', 'Requested days off'], weekly: ['weekly', 'Weekly preference off'], both: ['both', 'Requested + weekly (each driver once)'] };
function LegendCard({ mode }) {
  const items = [['blocked', 'Blocked — no requests'], MODE_LEGEND[mode] || MODE_LEGEND.requested, ['conflict', 'Asked off, still scheduled'],
    ['pending', 'Pending'], ['vet', 'VET'], ['vto', 'VTO']];
  return html`<div class="card rq-legend">
    ${items.map(([k, t]) => html`<span class="rq-leg"><span class=${'rq-chip rq-sw ' + k}></span>${t}</span>`)}
  </div>`;
}

// Blocked days ("blackout", 2026-10-19): the picked day's state + "Block this day…" (optional reason, managers
// only) / "Unblock". Days off already on file stay; the Drivers app refuses new requests and reviews.
function BlockBox({ date, today, blocked }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!canBlocks()) return null;
  const run = async (fn, ok) => {
    setBusy(true); setErr('');
    try { await fn(); toast(ok); setOpen(false); setReason(''); }
    catch (e) { setErr(`Couldn't save: ${e.message || e}`); }
    finally { setBusy(false); }
  };
  const block = (e) => {
    if (e) e.preventDefault();
    const r = blockReason(reason);
    if (r.error) { setErr(r.error); return; }
    run(() => blockDay(date, r.reason), 'Blocked — drivers can\'t ask for this day off.');
  };
  if (blocked) {
    return html`<div class="rq-blocked">
      <div><b>⛔ Blocked — no day-off requests from the drivers' app</b>
        ${blocked.reason ? html` <span class="muted rq-note">“${blocked.reason}”</span>` : ''}
        ${blocked.by ? html` <span class="muted rq-asked">by ${blocked.by}</span>` : ''}</div>
      ${err ? html`<div class="rq-bad" role="alert">${err}</div>` : ''}
      <button class="small" disabled=${busy} onClick=${() => run(() => unblockDay(date), 'Unblocked — drivers can ask for it again.')}>Unblock</button>
    </div>`;
  }
  if (date < today) return null;
  if (!open) return html`<div class="row rq-panelbtns"><button class="small" onClick=${() => setOpen(true)}>Block this day…</button></div>`;
  return html`<form class="rq-blockform" onSubmit=${block}>
    <input type="text" maxLength=${BLOCK_REASON_MAX} value=${reason} disabled=${busy} placeholder="Reason (optional)"
      aria-label="Reason (managers only)" onInput=${(e) => { setReason(e.target.value); setErr(''); }} />
    <div class="hint">Drivers won't be able to ask for this day off or send it for review — they see "this day is closed
      for requests". Days off already on file stay. Only managers see the reason.</div>
    ${err ? html`<div class="rq-bad" role="alert">${err}</div>` : ''}
    <div class="row"><button class="primary small" disabled=${busy}>Block this day</button>
      <button type="button" class="small ghost" disabled=${busy} onClick=${() => { setOpen(false); setErr(''); }}>Cancel</button></div>
  </form>`;
}

// "Weekly preference (N)": drivers whose Driver preferences keep them off this weekday going forward, with the
// rule in words (in Both, without the ones already under Requested). also = (Both) those drivers: listed after,
// greyed, "(also requested — counted once)", so the panel's sum line adds up on screen.
function WeeklyList({ list, also = [] }) {
  return html`<h3>Weekly preference (${list.length})</h3>
    ${list.length || also.length ? html`<ul class="rq-list">${list.map((u) => html`<li class="rq-row" key=${u.name}>
      <div class="rq-who"><b>${u.name}</b><span class="muted rq-asked">${u.rule}</span></div></li>`)}
      ${also.map((u) => html`<li class="rq-row muted" key=${'also|' + u.name}>
      <div class="rq-who"><span>${u.name}</span><span class="rq-asked">${u.rule} (also requested — counted once)</span></div></li>`)}</ul>`
      : html`<p class="muted rq-evnote">Nobody.</p>`}`;
}

// The picked day: its days off and its VET / VTO, "+ Add a day off" (that date) and "Post an offer"
// (that date when it can still be posted for — the Live board's own form; else the Live schedule).
// The off lists follow the "Off counts" mode: Requested (the days off), Weekly preference, or both groups.
function DayPanel({ date, view, days, today, names, show, blocked, mode }) {
  const [adding, setAdding] = useState(false);
  const [posting, setPosting] = useState(false);
  const label = dayLabel(date);
  const postable = canOffers() ? offerDays(days, today) : [];
  const post = () => { setAdding(false); if (postable.length) setPosting(true); else openLive(); };
  const [showDenied, setShowDenied] = useState(false);
  const showReq = mode !== 'weekly';
  const weekly = view.counts && mode !== 'requested' ? view.counts.weekly : null;
  const also = (view.counts && view.counts.also) || [];
  // Both: "Requested 10 + Weekly 16 − 1 counted once = 25" above the lists (Jose 2026-10-19)
  const sum = view.counts && view.counts.total ? bothLine(view.counts) : '';
  const nothing = !view.waiting.length && !(showReq && view.offs.length) && !view.denied.length && !view.offers.length
    && !(weekly && weekly.length) && !also.length;
  return html`<div class="card rq-panel">
    <h2>${longDate(date)}</h2>
    <${BlockBox} date=${date} today=${today} blocked=${view.blocked} />
    <div class="row rq-panelbtns">
      ${canTimeoff() && !adding ? html`<button class="small" onClick=${() => { setAdding(true); setPosting(false); }}>+ Add a day off</button>` : ''}
      ${canOffers() && !posting ? html`<button class="small" onClick=${post}>Post an offer</button>` : ''}
    </div>
    ${adding ? html`<${AddDayOff} date=${date} names=${names} blocked=${blocked} onDone=${() => setAdding(false)} />` : ''}
    ${posting ? html`<div class="rq-form"><${OfferForm} days=${days} today=${today}
      date=${postable.some((x) => x.date === date) ? date : today} uid="rq"
      onDone=${() => setPosting(false)} onCancel=${() => setPosting(false)} /></div>` : ''}
    ${!canTimeoff() && show !== 'vet' && show !== 'vto' ? html`<p class="muted">Days off need the JAJB hub's connection — open the Schedule Builder from the hub.</p>` : ''}
    ${view.working != null ? html`<p class="muted rq-evnote">Live schedule: ${view.working} working</p>` : ''}
    ${sum ? html`<p class="rq-evnote"><b>${sum}</b></p>` : ''}
    ${nothing ? html`<p class="muted" style="margin:0">Nothing asked for this day.</p>` : ''}
    ${view.waiting.length ? html`<h3 class="rq-waith">Waiting for your answer (${view.waiting.length})</h3>
      <ul class="rq-list">${view.waiting.map((r) => html`<${ReviewRow} r=${r} key=${r.id} />`)}</ul>` : ''}
    ${showReq && view.offs.length ? html`<h3>Requested (${view.offs.length})</h3>
      <ul class="rq-list">${view.offs.map((r) => html`<${OffRow} r=${r} label=${label} key=${r.key} />`)}</ul>` : ''}
    ${weekly ? html`<${WeeklyList} list=${weekly} also=${also} />` : ''}
    ${view.denied.length ? html`<button class="link rq-answered" aria-expanded=${showDenied} onClick=${() => setShowDenied((x) => !x)}>
      Answered (${view.denied.length}) ${showDenied ? '▾' : '▸'}</button>
      ${showDenied ? html`<ul class="rq-list">${view.denied.map((r) => html`<li class="rq-row" key=${r.id}>
        <div class="rq-who"><b>${r.name}</b><span class="chip gray">Denied</span>
          ${r.why ? html`<span class="muted rq-note">“${r.why}”</span>` : ''}
          ${r.decidedBy ? html`<span class="muted rq-asked">by ${r.decidedBy}</span>` : ''}</div>
      </li>`)}</ul>` : ''}` : ''}
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
  const [roster, setRoster] = useState([]);       // [{name, active?}] (loadDriverRoster with the active list)
  // "Off counts:" Requested / Weekly preference / Both (remembered) and the Driver preferences the weekly reads
  const [mode, setModeState] = useState(readOffMode);
  const setMode = (m) => { const v = offMode(m); setModeState(v); saveOffMode(v); };
  const [prefs, setPrefs] = useState(null);
  useEffect(() => {
    if (mode === 'requested' || prefs) return undefined;
    let alive = true;
    loadDriverPrefs().then((p) => { if (alive) setPrefs(p); }).catch(() => {});
    return () => { alive = false; };
  }, [mode]);
  // #requests/YYYY-MM-DD (app.js puts the day here): pick it once, then clear it
  const deep = useStore((st) => st.requestsDay);
  useEffect(() => {
    if (!deep) return;
    setSel(deep); setYm(monthOf(deep));
    setState({ requestsDay: null });
  }, [deep]);
  useEffect(() => {
    let alive = true;
    if (canLive()) loadDriverRoster({ active: true }).then((r) => { if (alive) setRoster((r || []).filter((x) => x && x.name)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // a tap on a day: on a phone (the panel is under the calendar) bring the panel into view
  const panelRef = useRef(null);
  const [tap, setTap] = useState(0);             // day taps (also a tap on the day already picked)

  const grid = monthGrid(ym);
  // the visible month's 6 weeks, the picked day's week, and the next 14 days (the alert + the offer form)
  const weeks = canLive() ? [...new Set([...grid.weeks, sundayOf(sel), ...weeksBetween(today, shiftISO(today, 13))])].sort() : [];
  const off = useFeed(subOff, weeks);
  const sm = useFeed(subSm, weeks);
  const offerWeeks = useFeed(subOffers, canOffers() ? weeks : []);
  const offers = weeks.flatMap((w) => (Array.isArray(offerWeeks[w]) ? offerWeeks[w] : []));
  const takesById = useTakesMap(offers.map((o) => o.id).sort());
  // day-off reviews: the visible month's days, and every one from today on (the alert)
  const rkMonth = `${grid.cells[0].date}|${grid.cells[41].date}`, rkNext = `${today}|`;
  const rv = useFeed(subReviews, canLive() && canReviews() ? [rkMonth, rkNext] : []);
  const reviews = [...new Map([...(rv[rkMonth] || []), ...(rv[rkNext] || [])].filter(Boolean).map((r) => [r.id, r])).values()];
  // blocked days of the visible month (+ the picked day when it's outside it)
  const bkSel = sel < grid.cells[0].date || sel > grid.cells[41].date ? `${sel}|${sel}` : rkMonth;
  const bk = useFeed(subBlocked, canLive() && canBlocks() ? [...new Set([rkMonth, bkSel])] : []);
  const blocked = { ...(bk[rkMonth] || {}), ...(bk[bkSel] || {}) };
  useEffect(() => {
    if (!tap) return;
    if (window.innerWidth < 1000 && panelRef.current) panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [tap]);

  if (!canLive()) return html`<${Banner} kind="info">Requests need the JAJB hub's connection — open the Schedule Builder from the hub.<//>`;

  // the active roster (no `active` marks = the active list couldn't be read: everyone on it)
  const activeNames = (roster.some((r) => 'active' in r) ? roster.filter((r) => r.active) : roster).map((r) => r.name);
  const src = { offByWeek: off, smByWeek: sm, offers, takesById, reviews, blocked,
    prefs: mode !== 'requested' ? prefs : null, activeNames: roster.length ? activeNames : null };
  const filter = { show, driver, counts: mode };
  const first = grid.cells[0].date, last = grid.cells[41].date;
  const views = dayViews(first, last, src, filter);
  const selView = (sel >= first && sel <= last ? views : dayViews(sel, sel, src, filter))[sel];
  const c = conflictsOf(off, sm, today, reviews);
  const rw = reviewsWaiting(reviews, today);
  const loading = grid.weeks.some((w) => (canTimeoff() && off[w] === undefined) || (canOffers() && offerWeeks[w] === undefined));
  const failed = grid.weeks.some((w) => off[w] === null || offerWeeks[w] === null) || rv[rkMonth] === null || bk[rkMonth] === null;
  // the offer form's days: the published days of the next 14 days (the Live board's view.days shape)
  const days = weeksBetween(today, shiftISO(today, 13)).flatMap((w) => (sm[w] && Array.isArray(sm[w].days) ? sm[w].days : []));
  // the driver search list: the roster + anyone named in the loaded days off / takes
  const names = [...new Set([...roster.map((r) => r.name),
    ...Object.values(off).flatMap((d) => Object.values(d || {}).map((t) => t && t.name)),
    ...Object.values(takesById).flatMap((t) => (Array.isArray(t) ? t.map((x) => x && x.name) : [])),
    ...reviews.map((r) => r.name)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const pick = (d) => { setTap((n) => n + 1); setSel(d); if (monthOf(d) !== ym) setYm(monthOf(d)); };

  return html`<div class="rq">
    ${c.drivers || rw.n ? html`<div class="card rq-alert" role="alert">
      ${c.drivers ? html`<div class="rq-alert-line">
        <b>${c.drivers} driver${c.drivers === 1 ? '' : 's'} asked off but ${c.drivers === 1 ? 'is' : 'are'} still on the schedule —</b>
        ${c.groups.map((g) => html`<button class="link rq-alert-it" title="Show this day" onClick=${() => pick(g.date)}>${g.label}: ${g.names.join(', ')}</button>`)}
      </div>` : ''}
      ${rw.n ? html`<div class="rq-alert-line">
        <b>${rw.n} day-off review${rw.n === 1 ? '' : 's'} waiting —</b>
        ${rw.groups.map((g) => html`<button class="link rq-alert-it" title="Show this day" onClick=${() => pick(g.date)}>${g.label}: ${g.names.join(', ')}</button>`)}
      </div>` : ''}
    </div>` : ''}
    <datalist id="rq-names">${names.map((n) => html`<option value=${n} />`)}</datalist>
    <div class="rq-layout">
      <div class="rq-left">
        <${FilterCard} show=${show} setShow=${setShow} driver=${driver} setDriver=${setDriver} mode=${mode} setMode=${setMode} />
        ${failed ? html`<${Banner} kind="warn">Couldn't load everything for this month — check the connection.<//>` : ''}
        <${CalendarCard} grid=${grid} views=${views} today=${today} sel=${sel} loading=${loading}
          onPick=${pick} onMonth=${(n) => setYm((m) => shiftMonth(m, n))} onToday=${() => { setYm(monthOf(today)); setSel(today); }} />
        <${LegendCard} mode=${mode} />
      </div>
      <div class="rq-right" ref=${panelRef}>
        <${DayPanel} key=${sel} date=${sel} view=${selView} days=${days} today=${today} names=${names} show=${show} blocked=${blocked} mode=${mode} />
      </div>
    </div>
  </div>`;
}

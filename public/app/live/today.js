// The "Today" page (Jose 2026-10-06: the old Overview was only the build
// checklist — "no good information at all"). Read straight from the
// published week's saved summary, so it opens at once (no rules engine):
// today's roster by wave, open slots, call-outs, drivers near a limit, the
// latest changes, and a small card for next week's build.
import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { setState, toast } from '../store.js';
import { Banner, Spinner, Icon } from '../ui.js';
import { liveWeeks, liveWeek, watchLiveWeek, watchLiveLog, watchActualHours, watchLiveConfirms, watchLiveLate, saveLiveLate,
  canActualHours } from '../api.js';
import { MissingCheck } from './missing.js';
import { parseISODate, toISODate, addDays } from '../lib/weeks.js';
import { sundayOf, todayISO, cellInfo, WAVE_COLORS, SHIFT_COLORS, prevISO, actualList, mergeActual,
  overRisk, runRisk, riskCardHtml, missingDays, withConfirmed, withRouteTracker, openTodayRisk, HARD_RUN,
  rtOnlyWeek, sharedTodayLines, actualLoadFailed, ACT_WAIT_MS } from './live-model.js';

const longDate = (iso) => parseISODate(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US',
  { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'just now');
const waveMins = (w) => { const m = String(w).match(/(\d{1,2}):(\d{2}) ([AP]M)/); if (!m) return 9999;
  return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2]; };
const waveBg = (w) => WAVE_COLORS[String(w).replace(/ [AP]M$/, '')] || SHIFT_COLORS.other;

function last7(dayHours, endISO) {
  let t = 0;
  for (let k = 0; k < 7; k++) t += Number((dayHours || {})[toISODate(addDays(parseISODate(endISO), -k))] || 0);
  return Math.round(t * 100) / 100;
}

// Who to keep an eye on: close to (or past) a limit — and, apart, those only in overtime.
// Colours (2026-10-10, the owner's rule: 6 days in 7 is allowed but flagged): 6 days — in a row,
// in 7, or in the week — is amber (lvl 2); red (lvl 3) only for 7 days in a row (HARD_RUN) or over
// the 7-day hours max. The engine's own build rules (max_consecutive etc.) are unchanged.
function watchList(sm, endISO) {
  const lim = sm.limits || {};
  const max7 = lim.max_7day_hours || 60, maxc = lim.max_consecutive || 5, maxd = lim.max_worked_days || 5;
  const maxd7 = lim.max_days_in_7 || 5;
  const cap = lim.weekly_hours_cap || 40;
  const out = [], ot = [];
  for (const d of sm.drivers || []) {
    const why = [];
    let lvl = 0;
    const m7 = d.max7 ?? 0;
    if (m7 > max7) { why.push(`${m7}h in 7 days — over ${max7}h`); lvl = 3; }
    else if (m7 >= max7 - 6) { why.push(`${m7}h in 7 days (max ${max7})`); lvl = Math.max(lvl, 2); }
    if ((d.max_days7 ?? 0) > maxd7) { why.push(`${d.max_days7} days worked in 7 (usual max ${maxd7})`); lvl = Math.max(lvl, d.max_days7 >= HARD_RUN ? 3 : 2); }
    if (d.streak >= HARD_RUN) { why.push(`${d.streak} days in a row`); lvl = Math.max(lvl, 3); }
    else if (d.streak > maxc) { why.push(`${d.streak} days in a row`); lvl = Math.max(lvl, 2); }
    else if (d.streak === maxc) { why.push(`${d.streak} days in a row`); lvl = Math.max(lvl, 1); }
    const nd = (d.worked_dates || []).length;
    if (nd > maxd) { why.push(`${nd}-day week`); lvl = Math.max(lvl, nd >= HARD_RUN ? 3 : 2); }
    const wk = d.clock_hours ?? d.hours ?? 0;
    if (why.length && wk > cap) why.push(`${wk}h this week — overtime`);
    if (why.length) out.push({ name: d.name, why, lvl, last7: endISO && d.day_hours ? last7(d.day_hours, endISO) : null, notScheduled: !!d.notScheduled });
    else if (wk > cap) ot.push({ name: d.name, wk });
  }
  return { near: out.sort((a, b) => b.lvl - a.lvl || a.name.localeCompare(b.name)), ot: ot.sort((a, b) => b.wk - a.wk) };
}

// The hours checks for one week as the page shows them (2026-10-10, factored out so the Route
// Tracker-only week runs the same code): risky = the red box — over the 7-day hours max on a day
// still ahead, 7 days in a row (HARD_RUN), or can't work today; watch = the watch list, plus
// anyone whose only problem is a 6th day in 7 (allowed, flagged: amber) and anyone out on a
// route today with an RTS line (openTodayRisk; nowMs = the minute it's checked at).
function limitChecks(sm, today, endISO, nowMs) {
  const lim = sm.limits || {};
  const { near: watch0, ot } = watchList(sm, endISO);
  const dayName = (iso) => (iso === today ? 'Today' : (sm.days.find((x) => x.date === iso) || {}).day || iso);
  const all = sm.drivers.map((d) => {
    const hours = overRisk(d, sm.days, today, lim), run = runRisk(d, sm.days, today, lim);
    if (hours) hours.backupH = lim.backup_hours || 2;
    const hot = [...new Set([...(hours ? hours.hot : []), ...(run ? run.hot : [])])].sort();
    // out on a route today, no clock-out yet (2026-10-10): the RTS time / 6th day in 7 / 7th day in a row
    const now = openTodayRisk(d, sm.days, today, lim, nowMs);
    if (!hot.length) return now && now.texts.length ? { d, hot, now, red: !!now.cant } : null;
    const runMax = run && run.hot.length ? Math.max(...run.runs.map((r) => r.length)) : 0;
    const what = [hours && hours.hot.length ? `over ${hours.max}h in 7 days (${Math.max(...hours.over.map((w) => w.total))}h)` : '',
      runMax ? `${runMax} days worked in 7` : ''].filter(Boolean).join(' and ');
    const red = !!(hours && hours.hot.length) || runMax >= HARD_RUN || !!(now && now.cant);
    return { d, risk: { hours, run }, hot, what, now, red };
  }).filter(Boolean);
  const risky = all.filter((x) => x.red && x.hot.length)
    .sort((a, b) => a.hot[0].localeCompare(b.hot[0]) || a.d.name.localeCompare(b.d.name));
  // the rest: on the watch list — a 6th day in 7 ahead (amber), and/or today's RTS line
  const watch = watch0.map((w) => ({ ...w }));
  for (const x of all.filter((y) => !(y.red && y.hot.length))) {
    const why = [];
    if (x.now && x.now.texts.length) why.push(`Today: ${x.now.texts.join(' · ')}`);
    if (x.hot.length) why.push(`would go ${x.what} (${x.hot.map(dayName).join(', ')})`);
    // one colour rule with the Live board (openTodayRisk level, 2026-10-10): an RTS time still
    // ahead / a 6th day in 7 = amber; past due, no hours left, can't work = red
    const lvl = x.red || (x.now && x.now.level === 'bad') ? 3 : 2;
    const w = watch.find((y) => y.name === x.d.name);
    if (w) { w.why = [...why, ...w.why]; w.lvl = Math.max(w.lvl, lvl); }
    else {
      watch.push({ name: x.d.name, why, lvl, notScheduled: !!x.d.notScheduled,
        last7: endISO && x.d.day_hours ? last7(x.d.day_hours, endISO) : null });
    }
  }
  watch.sort((a, b) => b.lvl - a.lvl || a.name.localeCompare(b.name));
  return { risky, watch, ot, dayName };
}

// The Route Tracker-only hours checks (this week's schedule isn't published), 2026-10-10 — used
// when another week is shown and when no week is published at all. chk = limitChecks(rtOnlyWeek …).
function rtOnlyCard(chk, actFail) {
  return html`<div class="card td-alert">
      <b>This week's schedule isn't published - hours are checked from Route Tracker only</b>
      ${chk.risky.length || chk.watch.length ? html`<ul class="td-watch">
        ${chk.risky.map((x) => { const w = chk.watch.find((y) => y.name === x.d.name);
          return html`<li class="lvl3"><b>${x.d.name}</b>
          <span>${x.now && x.now.texts.length ? `Today: ${x.now.texts.join(' · ')} · ` : ''}would go ${x.what} (${x.hot.map(chk.dayName).join(', ')})${w ? ` · ${w.why.join(' · ')}` : ''}</span></li>`; })}
        ${chk.watch.filter((w) => !chk.risky.some((x) => x.d.name === w.name)).map((w) => html`<li class=${'lvl' + w.lvl}><b>${w.name}</b>
          <span>${w.why.join(' · ')}${w.last7 != null ? html` <span class="muted">· last 7 days ${w.last7}h</span>` : ''}</span></li>`)}</ul>`
        : actFail ? '' : html`<p class="muted" style="margin:6px 0 0">Nobody on a route in Route Tracker is close to a limit.</p>`}
    </div>`;
}

// Late arrivals today (2026-10-08): the same marks as the Live board's shift menu — each goes on
// the next dispatch report's Late section (notify-only for discipline).
function LateCard({ week, today, people, lates }) {
  const [who, setWho] = useState('');
  const [t, setT] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = Object.values(lates || {}).filter((x) => x.day === today).sort((a, b) => a.name.localeCompare(b.name));
  const fmt = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); if (!m) return v; const h = +m[1]; return `${(h % 12) || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`; };
  const save = async (name, time) => {
    setBusy(true);
    try { await saveLiveLate(week, name, today, time); toast(time ? `${name} marked late (${time}) — it goes on the dispatch report` : `Late arrival removed for ${name}`); setWho(''); setT(''); }
    catch (e) { toast('Could not save: ' + (e.message || e), 'err'); }
    finally { setBusy(false); }
  };
  return html`<div class="card">
    <h2>Late arrivals today <span class="muted td-count">${mine.length}</span></h2>
    ${mine.length ? html`<div class="td-bkrow" style="margin-bottom:8px">${mine.map((x) => html`<span class="td-pill">⏰ ${x.name} · ${x.time}
      <button class="link" disabled=${busy} title="Remove" onClick=${() => save(x.name, '')}>✕</button></span>`)}</div>` : ''}
    <div class="row" style="gap:6px;flex-wrap:wrap">
      <select value=${who} onChange=${(e) => setWho(e.target.value)}>
        <option value="">Who was late?</option>
        ${people.filter((n) => !mine.some((x) => x.name === n)).map((n) => html`<option value=${n}>${n}</option>`)}
      </select>
      <input type="time" value=${t} onInput=${(e) => setT(e.target.value)} />
      <button class="small" disabled=${busy || !who || !t} onClick=${() => save(who, fmt(t))}>Mark late</button>
    </div>
    <p class="hint" style="margin:6px 0 0">It goes on the next dispatch report's Late section by itself. Taking it back before that report posts = it never counts.</p>
  </div>`;
}

export function Today({ buildCard }) {
  const [week, setWeek] = useState(undefined);   // the published week to show (meta) | null
  const [smRaw, setSm] = useState(null);         // its saved summary
  const [act, setAct] = useState({});            // Route Tracker's actual hours {cur, prev}
  const [confirms, setConfirms] = useState({});  // "not in Route Tracker" answers
  const [lates, setLates] = useState({});          // late arrivals {"<ISO day>|<name>": {time, by}}
  const [log, setLog] = useState([]);
  const [rev, setRev] = useState(null);
  const [err, setErr] = useState('');
  const [actAt, setActAt] = useState(0);         // when the actual_hours watches started (ms)
  const [actT, setActT] = useState({});          // today's week's actual hours {cur, prev}, when it isn't the shown week
  const [actTAt, setActTAt] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const today = todayISO();
  const tw = sundayOf(today);

  // re-checked once a minute (2026-10-10): the 12-hour-day RTS line appears on its own an hour
  // before, and a Route Tracker read that never answers gets flagged
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    liveWeeks(12).then((ws) => {
      const t = sundayOf(today);
      // this week; else the next one coming up; else the latest
      setWeek(ws.find((w) => w.week === t) || ws.filter((w) => w.week > t).pop() || ws[0] || null);
    }).catch((e) => { setErr(e.message || String(e)); setWeek(null); });
  }, []);

  useEffect(() => {
    if (!week) return undefined;
    const un1 = watchLiveWeek(week.week, (m) => { if (m) setRev(m.rev); });
    const un2 = watchLiveLog(week.week, (l) => setLog(l));
    return () => { un1(); un2(); };
  }, [week && week.week]);

  // days already worked count their real hours (Route Tracker clock-outs), live
  useEffect(() => {
    if (!week) return undefined;
    const un1 = watchActualHours(week.week, (d) => setAct((a) => ({ ...a, cur: d })));
    const un2 = watchActualHours(prevISO(week.week), (d) => setAct((a) => ({ ...a, prev: d })));
    const un3 = watchLiveConfirms(week.week, (c) => setConfirms(c || {}));
    const un4 = watchLiveLate(week.week, (l) => setLates(l || {}));
    setActAt(Date.now());
    const t = setTimeout(() => setNowMs(Date.now()), ACT_WAIT_MS + 500);
    return () => { un1(); un2(); un3(); un4(); clearTimeout(t); };
  }, [week && week.week]);

  // this week's schedule isn't published (the page shows another week, 2026-10-10): Route
  // Tracker's hours for today's week still run the hours checks for whoever is on a route —
  // also when no week is published at all (week null, 2026-10-10)
  const other = week === null || (!!week && week.week !== tw);
  useEffect(() => {
    if (!other) return undefined;
    setActT({});
    const un1 = watchActualHours(tw, (d) => setActT((a) => ({ ...a, cur: d })));
    const un2 = watchActualHours(prevISO(tw), (d) => setActT((a) => ({ ...a, prev: d })));
    setActTAt(Date.now());
    const t = setTimeout(() => setNowMs(Date.now()), ACT_WAIT_MS + 500);
    return () => { un1(); un2(); clearTimeout(t); };
  }, [other, tw]);
  const actList = actualList(act.prev, act.cur);
  const missing = smRaw ? missingDays(smRaw, actList, confirms) : [];
  // + Route Tracker drivers not on the schedule, and today's route with no clock-out yet (2026-10-10)
  const actC = smRaw ? withConfirmed(actList, missing, smRaw.limits || {}) : actList;
  const sm = smRaw && withRouteTracker(mergeActual(smRaw, actC), actC, today);

  useEffect(() => {
    if (!week || rev == null) return;
    liveWeek(week.week).then((d) => { if (d) setSm(JSON.parse(d.summary)); }).catch((e) => setErr(e.message || String(e)));
  }, [week && week.week, rev]);

  const openLive = () => setState({ route: 'live' });

  if (week === undefined) return html`<div class="card"><${Spinner}/> Loading this week…</div>`;
  if (!week) {
    // nothing published at all: the Route Tracker-only checks still run for today's week (2026-10-10)
    const rtChk0 = limitChecks(rtOnlyWeek(tw, {}, actualList(actT.prev, actT.cur), today), today, today, nowMs);
    const actFail0 = canActualHours() && actualLoadFailed(actT, actTAt, nowMs);
    return html`<div>
      ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
      ${actFail0 ? html`<div class="card td-alert"><div class="lv-bad"><b>Route Tracker hours didn't load - check hours by hand</b></div></div>` : ''}
      ${rtOnlyCard(rtChk0, actFail0)}
      <div class="card hero"><div class="hero-ico">${Icon('live', 24)}</div>
        <h2>No week is published yet</h2>
        <p class="hint">Build a schedule and press <b>Publish</b> on the Build step — this page then shows the week day by day.</p></div>
      ${buildCard}</div>`;
  }
  if (!sm) return html`<div class="card"><${Spinner}/> Loading ${week.label}…</div>`;

  const info = sm.days.find((x) => x.date === today);
  const inWeek = !!info;
  const day = info || sm.days.find((x) => x.open && x.date > today) || sm.days.find((x) => x.open);
  const lastDay = sm.days[sm.days.length - 1].date;
  const endISO = today < sm.days[0].date ? null : today > lastDay ? lastDay : today;

  // the day's people, by what they do
  const waves = {}, backups = {}, trainers = [], dispatch = [], meetings = [], marks = [];
  for (const d of sm.drivers) {
    const v = (d.cells || {})[day.day];
    const c = cellInfo(v);
    if (c.kind === 'road' || c.kind === 'trainee') (waves[c.top] = waves[c.top] || []).push({ name: d.name, trainee: c.kind === 'trainee' });
    else if (c.kind === 'bk') (backups[c.top] = backups[c.top] || []).push(d.name);
    else if (c.kind === 'trainer') trainers.push({ name: d.name, partner: c.partner, wave: c.top });
    else if (c.kind === 'disp') dispatch.push(d.name);
    else if (c.kind === 'meet') meetings.push(`${d.name}${c.top && c.top !== 'Meeting' ? ' · ' + c.top : ''}`);
    else if (c.kind === 'mark') marks.push({ name: d.name, what: c.top, ...((sm.marks || []).find((m) => m.name === d.name && m.day === day.day) || {}) });
  }
  const waveKeys = [...new Set([...Object.keys(day.waves || {}), ...Object.keys(waves), ...Object.keys(backups)])]
    .sort((a, b) => waveMins(a) - waveMins(b));
  const openR = Math.max(0, day.routes - day.routes_filled), openB = Math.max(0, day.backup - day.backup_filled);
  const weekOpen = sm.days.filter((x) => x.open && x.date >= today)
    .map((x) => ({ day: x.day, date: x.date, r: Math.max(0, x.routes - x.routes_filled), b: Math.max(0, x.backup - x.backup_filled) }))
    .filter((x) => x.r || x.b);
  // who would break a hard limit (over the 7-day hours max / 7 days in a row) on a day still
  // ahead — the same check and card as the Live board's shaking days; a 6th day in 7 and today's
  // RTS lines go on the watch list (limitChecks, 2026-10-10)
  const lim = sm.limits || {};
  const { risky, watch, ot, dayName } = limitChecks(sm, today, endISO, nowMs);
  // this week's schedule isn't published: the hours checks from Route Tracker alone (2026-10-10)
  const rtSm = other ? rtOnlyWeek(tw, lim, actualList(actT.prev, actT.cur), today) : null;
  const rtChk = rtSm ? limitChecks(rtSm, today, today, nowMs) : null;
  // Route Tracker's hours didn't load (today's week): say so — the checks can't be trusted
  const actFail = canActualHours() && (other ? actualLoadFailed(actT, actTAt, nowMs) : actualLoadFailed(act, actAt, nowMs));
  // someone on a route today that can't be told apart from a schedule driver: no hours checks ran
  const shared = other ? [] : sharedTodayLines(smRaw, actList, today);
  const nBk = Object.values(backups).reduce((a, l) => a + l.length, 0);

  return html`<div class="today">
    ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
    <div class="card td-head">
      <div>
        <div class="td-title">${inWeek ? `Today — ${longDate(today)}` : `Coming up — ${longDate(day.date)}`}</div>
        <div class="muted">${sm.label}${inWeek ? '' : ' · this week is not published yet, showing the next one'}</div>
      </div>
      <button class="primary" onClick=${openLive}>Open the Live schedule ${Icon('arrow', 16)}</button>
    </div>

    ${actFail || shared.length ? html`<div class="card td-alert">
      ${actFail ? html`<div class="lv-bad"><b>Route Tracker hours didn't load - check hours by hand</b></div>` : ''}
      ${shared.map((x) => html`<div class="lv-bad"><b>${x.line}</b></div>`)}
    </div>` : ''}

    ${rtChk ? rtOnlyCard(rtChk, actFail) : ''}

    ${!day.open ? html`<div class="card"><p class="muted" style="margin:0">The station is closed ${day.day}.</p></div>` : html`
    <div class="stats">
      <div class="stat"><div class=${'big' + (openR ? ' lv-bad' : '')}>${day.routes_filled}/${day.routes}</div><div class="muted">routes filled</div></div>
      <div class="stat"><div class=${'big' + (openB ? ' lv-warnc' : '')}>${day.backup_filled}/${day.backup}</div><div class="muted">backups</div></div>
      <div class="stat"><div class=${'big' + (marks.length ? ' lv-bad' : '')}>${marks.length}</div><div class="muted">called out / no-show</div></div>
      <div class="stat"><div class=${'big' + (risky.length ? ' lv-bad' : '')}>${risky.length}</div><div class="muted">would break a limit</div></div>
      <div class="stat"><div class=${'big' + (watch.some((w) => w.lvl >= 2) ? ' lv-warnc' : '')}>${watch.length}</div><div class="muted">close to a limit</div></div>
    </div>`}

    ${risky.length ? html`<div class="card td-risk">
      <div class="td-risk-head">
        <svg viewBox="0 0 100 90" width="44" height="40" aria-hidden="true"><polygon points="50,4 96,86 4,86" fill="#d62d20" stroke="#8f1b12" stroke-width="3" stroke-linejoin="round"/>
          <rect x="45" y="30" width="10" height="32" rx="4" fill="#fff"/><circle cx="50" cy="73" r="6.5" fill="#fff"/></svg>
        <div><div class="td-risk-title">${risky.length === 1 ? '1 driver would break a limit' : `${risky.length} drivers would break a limit`}</div>
          <div class="muted">Over ${lim.max_7day_hours || 60}h in 7 days, or ${HARD_RUN} days in a row. Fix it before they go out — each one shows how.</div></div>
        <button class="primary" onClick=${openLive}>Fix it on the Live schedule ${Icon('arrow', 16)}</button>
      </div>
      ${risky.map((x, i) => html`<details class="td-risk-one" open=${i === 0}>
        <summary><b>${x.d.name}</b>${x.d.notScheduled ? html` <span class="chip gray">not on the schedule</span>` : ''} — would go ${x.what}
          <span class="td-risk-days">${x.hot.map((iso) => html`<span class=${'td-open' + (iso === today ? ' now' : '')}>${dayName(iso)}</span>`)}</span>
          ${x.now && x.now.texts.length ? html` <b class=${x.now.level === 'warn' ? 'lv-warn' : 'lv-bad'}>${x.now.texts.join(' · ')}</b>` : ''}</summary>
        <div class="td-risk-body" dangerouslySetInnerHTML=${{ __html: riskCardHtml(x.d, x.risk, null,
          '✓ = already worked. On the Live schedule these days shake — click one to change it.') }} />
      </details>`)}
    </div>` : ''}

    <${MissingCheck} week=${week.week} missing=${missing} />

    ${weekOpen.length ? html`<div class="card td-alert">
      <b>Open slots still to fill:</b>
      ${weekOpen.map((x) => html`<span class="td-open">${x.date === today ? 'Today' : x.day}: ${[x.r ? `${x.r} route${x.r === 1 ? '' : 's'}` : '', x.b ? `${x.b} backup${x.b === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}</span>`)}
      <button class="small" onClick=${openLive}>Fill them on the Live schedule</button>
    </div>` : ''}

    ${day.open ? html`<div class="card">
      <h2>${inWeek ? 'Backups today' : `Backups ${day.day}`} <span class=${'muted td-count' + (openB ? ' lv-warnc' : '')}>${nBk} of ${day.backup}</span></h2>
      ${!nBk ? html`<p class="muted" style="margin:0">Nobody is on backup${inWeek ? ' today' : ''}.</p>` : html`<div class="td-bkrow">
        ${waveKeys.filter((w) => (backups[w] || []).length).map((w) => html`<div class="td-bkwave">
          <span class="td-bkhead" style=${`background:${waveBg(w)}`}>${w}</span>
          ${backups[w].map((n) => html`<span class="td-pill">${n}</span>`)}</div>`)}</div>`}
    </div>` : ''}

    ${inWeek && day.open ? html`<${LateCard} week=${week.week} today=${today} lates=${lates}
      people=${[...new Set([...Object.values(waves).flat().map((p) => p.name), ...Object.values(backups).flat(),
        ...trainers.map((x) => x.name)])].sort()} />` : ''}

    ${day.open ? html`<div class="card">
      <h2>${inWeek ? 'On the road today' : `On the road ${day.day}`}</h2>
      <div class="td-waves">
        ${waveKeys.map((w) => {
          const list = waves[w] || [], want = (day.waves || {})[w] || 0;
          if (!list.length && !want) return '';
          return html`<div class="td-wave">
            <div class="td-wavehead" style=${`background:${waveBg(w)}`}><b>${w}</b>
              <span class=${list.length < want ? 'lv-bad' : ''}>${list.length}/${want}</span></div>
            <ul>${list.map((p) => html`<li>${p.name}${p.trainee ? html` <span class="chip trainer-chip">trainee</span>` : ''}</li>`)}
              ${!list.length ? html`<li class="muted">—</li>` : ''}</ul>
          </div>`;
        })}
      </div>
      ${trainers.length || dispatch.length || meetings.length || marks.length ? html`<div class="td-other">
        ${trainers.length ? html`<div><span class="lv-sw" style=${`background:${SHIFT_COLORS.trainer}`}>Trainers</span>
          ${trainers.map((t) => html`<span class="td-pill">${t.name} → ${t.partner} (${t.wave})</span>`)}</div>` : ''}
        ${dispatch.length ? html`<div><span class="lv-sw" style=${`background:${SHIFT_COLORS.disp}`}>Dispatch</span>
          ${dispatch.map((n) => html`<span class="td-pill">${n}</span>`)}</div>` : ''}
        ${meetings.length ? html`<div><span class="lv-sw" style=${`background:${SHIFT_COLORS.meet}`}>Meetings</span>
          ${meetings.map((n) => html`<span class="td-pill">${n}</span>`)}</div>` : ''}
        ${marks.length ? html`<div><span class="lv-sw" style=${`background:${SHIFT_COLORS.mark}`}>Not coming</span>
          ${marks.map((m) => html`<span class="td-pill">${m.name} — ${m.what}${m.note ? ` (${m.note})` : ''}</span>`)}</div>` : ''}
      </div>` : ''}
    </div>` : ''}

    <div class="td-cols">
      <div class="card">
        <h2>Watch list</h2>
        <p class="hint">Close to a limit this week: ${sm.limits?.max_7day_hours || 60}h in 7 days, days in a row, 6 days in 7.
          Orange = close, or 6 days (allowed, flagged). Red = over ${sm.limits?.max_7day_hours || 60}h or ${HARD_RUN} days in a row. Anyone who would break a limit is in the red box at the top.</p>
        ${!watch.length ? html`<p class="muted">Nobody is close to a limit.</p>` : html`<ul class="td-watch">
          ${watch.map((w) => html`<li class=${'lvl' + w.lvl}><b>${w.name}</b>${w.notScheduled ? html` <span class="chip gray">not on the schedule</span>` : ''}
            <span>${w.why.join(' · ')}${w.last7 != null ? html` <span class="muted">· last 7 days ${w.last7}h</span>` : ''}</span></li>`)}</ul>`}
        ${ot.length ? html`<details class="td-ot"><summary>${ot.length} more in overtime only (over ${sm.limits?.weekly_hours_cap || 40}h this week)</summary>
          <div class="td-otlist">${ot.map((o) => html`<span class="td-pill">${o.name} · ${o.wk}h</span>`)}</div></details>` : ''}
      </div>
      <div class="card">
        <h2>Latest changes</h2>
        ${!log.length ? html`<p class="muted">No changes yet.</p>` : html`<ul class="lv-log">
          ${log.slice(0, 7).map((l) => html`<li class=${'k-' + l.kind}><span class="lv-when">${when(l.at)}</span> <b>${l.by || '—'}</b> — ${l.text}</li>`)}</ul>`}
        <button class="small" style="margin-top:10px" onClick=${openLive}>See the full log</button>
      </div>
    </div>

    ${buildCard}
  </div>`;
}

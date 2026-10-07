// The "Today" page (Jose 2026-10-06: the old Overview was only the build
// checklist — "no good information at all"). Read straight from the
// published week's saved summary, so it opens at once (no rules engine):
// today's roster by wave, open slots, call-outs, drivers near a limit, the
// latest changes, and a small card for next week's build.
import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { setState } from '../store.js';
import { Banner, Spinner, Icon } from '../ui.js';
import { liveWeeks, liveWeek, watchLiveWeek, watchLiveLog, watchActualHours } from '../api.js';
import { parseISODate, toISODate, addDays } from '../lib/weeks.js';
import { sundayOf, todayISO, cellInfo, WAVE_COLORS, SHIFT_COLORS, prevISO, actualList, mergeActual } from './live-model.js';

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

// Who to keep an eye on: close to (or past) a limit.
function watchList(sm, endISO) {
  const lim = sm.limits || {};
  const max7 = lim.max_7day_hours || 60, maxc = lim.max_consecutive || 5, maxd = lim.max_worked_days || 5;
  const cap = lim.weekly_hours_cap || 40;
  const out = [];
  for (const d of sm.drivers || []) {
    const why = [];
    let lvl = 0;
    const m7 = d.max7 ?? 0;
    if (m7 > max7) { why.push(`${m7}h in 7 days — over ${max7}h`); lvl = 3; }
    else if (m7 >= max7 - 6) { why.push(`${m7}h in 7 days (max ${max7})`); lvl = Math.max(lvl, 2); }
    if (d.streak > maxc) { why.push(`${d.streak} days in a row`); lvl = Math.max(lvl, 3); }
    else if (d.streak === maxc) { why.push(`${d.streak} days in a row — a 6th needs the pop-up`); lvl = Math.max(lvl, 1); }
    const nd = (d.worked_dates || []).length;
    if (nd > maxd) { why.push(`${nd}-day week`); lvl = Math.max(lvl, 2); }
    const wk = d.clock_hours ?? d.hours ?? 0;
    if (wk > cap) { why.push(`${wk}h this week — overtime`); lvl = Math.max(lvl, 2); }
    if (why.length) out.push({ name: d.name, why, lvl, last7: endISO && d.day_hours ? last7(d.day_hours, endISO) : null });
  }
  return out.sort((a, b) => b.lvl - a.lvl || a.name.localeCompare(b.name));
}

export function Today({ buildCard }) {
  const [week, setWeek] = useState(undefined);   // the published week to show (meta) | null
  const [smRaw, setSm] = useState(null);         // its saved summary
  const [act, setAct] = useState({});            // Route Tracker's actual hours {cur, prev}
  const [log, setLog] = useState([]);
  const [rev, setRev] = useState(null);
  const [err, setErr] = useState('');
  const today = todayISO();

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
    return () => { un1(); un2(); };
  }, [week && week.week]);
  const sm = smRaw && mergeActual(smRaw, actualList(act.prev, act.cur));

  useEffect(() => {
    if (!week || rev == null) return;
    liveWeek(week.week).then((d) => { if (d) setSm(JSON.parse(d.summary)); }).catch((e) => setErr(e.message || String(e)));
  }, [week && week.week, rev]);

  const openLive = () => setState({ route: 'live' });

  if (week === undefined) return html`<div class="card"><${Spinner}/> Loading this week…</div>`;
  if (!week) {
    return html`<div>
      ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
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
  const watch = watchList(sm, endISO);

  return html`<div class="today">
    ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
    <div class="card td-head">
      <div>
        <div class="td-title">${inWeek ? `Today — ${longDate(today)}` : `Coming up — ${longDate(day.date)}`}</div>
        <div class="muted">${sm.label}${inWeek ? '' : ' · this week is not published yet, showing the next one'}</div>
      </div>
      <button class="primary" onClick=${openLive}>Open the Live schedule ${Icon('arrow', 16)}</button>
    </div>

    ${!day.open ? html`<div class="card"><p class="muted" style="margin:0">The station is closed ${day.day}.</p></div>` : html`
    <div class="stats">
      <div class="stat"><div class=${'big' + (openR ? ' lv-bad' : '')}>${day.routes_filled}/${day.routes}</div><div class="muted">routes filled</div></div>
      <div class="stat"><div class=${'big' + (openB ? ' lv-warnc' : '')}>${day.backup_filled}/${day.backup}</div><div class="muted">backups</div></div>
      <div class="stat"><div class=${'big' + (marks.length ? ' lv-bad' : '')}>${marks.length}</div><div class="muted">called out / no-show</div></div>
      <div class="stat"><div class=${'big' + (watch.some((w) => w.lvl >= 2) ? ' lv-warnc' : '')}>${watch.length}</div><div class="muted">drivers near a limit</div></div>
    </div>`}

    ${weekOpen.length ? html`<div class="card td-alert">
      <b>Open slots still to fill:</b>
      ${weekOpen.map((x) => html`<span class="td-open">${x.date === today ? 'Today' : x.day}: ${[x.r ? `${x.r} route${x.r === 1 ? '' : 's'}` : '', x.b ? `${x.b} backup${x.b === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}</span>`)}
      <button class="small" onClick=${openLive}>Fill them on the Live schedule</button>
    </div>` : ''}

    ${day.open ? html`<div class="card">
      <h2>${inWeek ? 'On the road today' : `On the road ${day.day}`}</h2>
      <div class="td-waves">
        ${waveKeys.map((w) => {
          const list = waves[w] || [], want = (day.waves || {})[w] || 0;
          return html`<div class="td-wave">
            <div class="td-wavehead" style=${`background:${waveBg(w)}`}><b>${w}</b>
              <span class=${list.length < want ? 'lv-bad' : ''}>${list.length}/${want}</span></div>
            <ul>${list.map((p) => html`<li>${p.name}${p.trainee ? html` <span class="chip trainer-chip">trainee</span>` : ''}</li>`)}
              ${(backups[w] || []).map((n) => html`<li class="td-bk">${n} <span class="muted">· backup</span></li>`)}
              ${!list.length && !(backups[w] || []).length ? html`<li class="muted">—</li>` : ''}</ul>
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
        <p class="hint">Drivers close to a limit this week: ${sm.limits?.max_7day_hours || 60}h in 7 days, days in a row, a 6-day week, overtime.</p>
        ${!watch.length ? html`<p class="muted">Nobody is close to a limit.</p>` : html`<ul class="td-watch">
          ${watch.map((w) => html`<li class=${'lvl' + w.lvl}><b>${w.name}</b>
            <span>${w.why.join(' · ')}${w.last7 != null ? html` <span class="muted">· last 7 days ${w.last7}h</span>` : ''}</span></li>`)}</ul>`}
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

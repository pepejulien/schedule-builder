// The Live board (2026-10-06): the published week, worked day to day. Every
// login with the Schedule Builder can change it; every change is saved to
// Firestore as one transaction with a line in the week's change log.
//
// Rules are the builder's own (runner.py _assess): green = safe, yellow =
// policy (allowed, flagged), red = they asked the day off (typed confirm),
// grey = compliance (locked). Hours are SCHEDULED hours on the clock (route
// 10h, backup 2h, meeting 2h, dispatch 12h). Here only, a 6th day worked in 7
// (last week counts) and overtime go through after a pop-up (orange) -- the
// 6-in-7 days then shake with ways to fix it; 12h a day / 60h in 7 days / 7 days
// in 7 stay locked. Cells use Amazon's own shift colors (2026-10-06).
import { html } from '../preact-setup.js';
import { useState, useEffect, useRef } from 'preact/hooks';
import { setState, setWizard, toast } from '../store.js';
import { Banner, Spinner, Icon, download } from '../ui.js';
import { liveRequest } from '../solver-client.js';
import { canLive, liveWeeks, liveWeek, watchLiveWeek, watchLiveLog, watchActualHours, watchLiveNotes, saveLiveNote, watchLiveConfirms } from '../api.js';
import { MissingCheck } from './missing.js';
import { driverCsv } from '../lib/driver-csv.js';
import { parseISODate } from '../lib/weeks.js';
import {
  WaveEditor, SlotEditor, ConfirmOverride, LimitConfirm, runConfirmed, TIER_META, TIER_ORDER,
  translateInfeasible, translateOverride, RuleProblems,
} from '../steps/step9-build.js';
import {
  loadEngine, saveWeek, logLines, summaryFromReport, sundayOf, todayISO, cellInfo,
  WAVE_COLORS, SHIFT_COLORS, ACT_LOADED, actualSig, prevISO, overRisk, runRisk, riskCardHtml, roomOn, clockOutBy, missingDays, workedSig, actualList,
} from './live-model.js';
import { parseISODate as pd, toISODate, addDays } from '../lib/weeks.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MUT = new Set(['apply', 'apply_add', 'apply_wave', 'undo', 'apply_mark', 'clear_mark', 'set_role', 'set_duty', 'clear_duty']);
const KIND = { apply: 'edit', apply_add: 'extra', apply_wave: 'wave', undo: 'undo', apply_mark: 'mark', clear_mark: 'mark',
  set_role: 'edit', set_duty: 'duty', clear_duty: 'duty' };
const MARKS = [
  ['callout', 'Called out', 'They called in and won\'t work.'],
  ['noshow', 'No-show', 'They didn\'t show up and didn\'t call.'],
  ['off', 'Day off', 'They asked for the day off during the week.'],
];

// Name search ignores case and accents ("jose" finds "José").
const fold = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// The sort choice is a per-device convenience (Jose 2026-10-06).
const SORT_KEY = 'lv_sort';
const readSort = () => { try { return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'tier'; } catch { return 'tier'; } };
const saveSort = (v) => { try { localStorage.setItem(SORT_KEY, v); } catch { /* private window */ } };

// Sum of on-the-clock hours over the 7 days ending `endISO`.
function last7(dayHours, endISO) {
  let t = 0;
  for (let k = 0; k < 7; k++) t += Number((dayHours || {})[toISODate(addDays(pd(endISO), -k))] || 0);
  return Math.round(t * 100) / 100;
}
// "If sent out" (Jose 2026-10-07): Max 7d counts a backup day as 2h, so it can't say what
// happens if a backup gets a route. This is the same number with every backup day still ahead
// (not worked yet) counted as a full route. null = no such backup days.
function max7IfSent(d, days, today, lim) {
  const dh = { ...(d.day_hours || {}) }, act = new Set(d.act_dates || []), full = lim.primary_hours || 10;
  const bk = days.filter((x) => x.date >= today && !act.has(x.date) && cellInfo((d.cells || {})[x.day]).kind === 'bk');
  if (!bk.length) return null;
  for (const x of bk) dh[x.date] = full;
  let best = 0;
  for (const x of days) {
    let t = 0;
    for (let k = 0; k < 7; k++) t += Number(dh[toISODate(addDays(pd(x.date), -k))] || 0);
    best = Math.max(best, t);
  }
  return Math.round(best * 100) / 100;
}

// The over-the-limit card (hours in 7 days / days in a row): the same HTML the Vehicle
// Assigner's alarm pop-up shows (limits.js riskCardHtml).
function RiskInfo({ d, risk, iso }) {
  return html`<div dangerouslySetInnerHTML=${{ __html: riskCardHtml(d, risk, iso) }} />`;
}

function Block({ v }) {
  const c = cellInfo(v);
  if (c.kind === 'empty') return '';
  return html`<div class=${'lv-blk b-' + c.kind} style=${c.bg ? `background:${c.bg}` : ''}>
    <span>${c.top}</span>${c.sub ? html`<small>${c.sub}</small>` : ''}</div>`;
}

// "P1 INFEASIBLE Tue: filled 5/6" -> plain words for a week already running
function openText(line) {
  let m = line.match(/P1 INFEASIBLE (\w+): filled (\d+)\/(\d+)/);
  if (m) { const n = m[3] - m[2]; return `${m[1]}: ${n} route${n === 1 ? '' : 's'} open (${m[2]} of ${m[3]} filled).`; }
  m = line.match(/P2 SHORT (\w+): (\d+)\/(\d+)/);
  if (m) { const n = m[3] - m[2]; return `${m[1]}: ${n} backup${n === 1 ? '' : 's'} open (${m[2]} of ${m[3]} filled).`; }
  return translateInfeasible(line);
}

const shortDate = (iso) => { const d = parseISODate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US',
  { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'just now');

function NotHere() {
  return html`<div class="card hero">
    <div class="hero-ico">${Icon('live', 24)}</div>
    <h2>The Live board runs on the JAJB site</h2>
    <p class="hint">Open <a href="https://jajb-ops.web.app/schedule/">jajb-ops.web.app/schedule/</a> — published weeks,
      midweek changes and their history are saved there, shared by everyone with the Schedule Builder.</p>
  </div>`;
}

// "10:05 AM" < "10:25 AM" < "1:05 PM"
const waveMins = (w) => { const m = String(w).match(/(\d{1,2}):(\d{2}) ([AP]M)/); if (!m) return 9999;
  return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2]; };

// Routes driven per wave on a day, from the grid (trainees drive).
function waveFills(view, day) {
  const out = {};
  for (const x of view.drivers) {
    const c = cellInfo((x.cells || {})[day]);
    if (c.kind === 'road' || c.kind === 'trainee') out[c.top] = (out[c.top] || 0) + 1;
  }
  return out;
}

// Jose 2026-10-06: clicking a day shows THAT day's choices right away — every
// wave from the color key (a full wave, or one the day has no routes in yet,
// just gets one more route: Amazon may have handed out routes the app
// doesn't know yet), plus trainer / meeting / dispatch. Rule results show up
// front; the day-off and overtime pop-ups still come where they're needed.
const ALL_WAVES = Object.keys(WAVE_COLORS).map((w) => `${w} AM`);
const dayWaves = (info) => [...new Set([...ALL_WAVES, ...Object.keys(info.waves || {})])]
  .sort((a, b) => waveMins(a) - waveMins(b));
const waveBg = (w) => WAVE_COLORS[String(w).replace(/ [AP]M$/, '')] || SHIFT_COLORS.other;

// A rule result in one line: locked (with why), or the notes that come with it.
function RuleNote({ st, first }) {
  if (!st) return '';
  if (st.status === 'blocked') return html`<div class="lv-lock">🔒 ${st.reasons.join('; ')}</div>`;
  const warns = (st.status === 'warn' || st.status === 'full') ? st.reasons.filter((r) => !/^(6-day|overtime)/.test(r)) : [];
  return html`
    ${st.status === 'unavail' ? html`<div class="lv-note unavail">${first} asked for this day off — you'll confirm first.</div>` : ''}
    ${(st.limits || []).length ? html`<div class="lv-note confirm">${st.limits.join('; ')} — a pop-up will ask you first.</div>` : ''}
    ${warns.length ? html`<div class="lv-note warn">Allowed, but flagged: ${warns.join('; ')}</div>` : ''}`;
}

function DayShifts({ name, info, road, fills, busy, onPick, compact }) {
  const first = name.split(/\s+/)[0];
  if (!road) return html`<p class="muted"><${Spinner}/> Checking the rules…</p>`;
  if (road.status === 'blocked') return html`<${RuleNote} st=${road} first=${first} />`;
  return html`<div class="lv-dayshifts">
    <${RuleNote} st=${road} first=${first} />
    <div class=${'lv-wavebtns' + (compact ? ' compact' : '')}>
      ${dayWaves(info).map((w) => {
        const want = (info.waves || {})[w] || 0, got = fills[w] || 0;
        const state = !want ? 'new wave · +1 route' : got >= want ? 'full · +1 route' : `${got} of ${want} filled`;
        return html`<button class="lv-wavebtn" disabled=${busy} style=${`background:${waveBg(w)}`}
          aria-label=${`${w}: ${state}`} title=${state} onClick=${() => onPick(w)}>
          <b>${w}</b><small>${state}</small></button>`;
      })}
    </div>
  </div>`;
}

// One labelled action tile: a big readable title and a short "what it does".
const Act = ({ icon, title, sub, onClick, busy, tone }) => html`<button class=${'dm-act' + (tone ? ' ' + tone : '')}
  disabled=${busy} onClick=${onClick}><span class="dm-ico">${icon}</span>
  <span><b>${title}</b>${sub ? html`<small>${sub}</small>` : ''}</span></button>`;

// "13:00" -> "1:00 PM"
const ampm = (t) => { const [h, m] = String(t || '13:00').split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };

// Hours left on one day under the 7-day max (Jose 2026-10-07: he couldn't see how long a driver
// could still work, to decide on a split route). Only for days not worked yet, and only when a
// long day could reach the max. Clock-out time: the shift's time on the schedule IS the clock-in
// (Jose 2026-10-07; Amazon's departure is 40 min later), 30-min lunch, 30 minutes early — the
// same result as the Vehicle Assigner, which starts from the departure minus 40.
function HoursLeft({ d, info, v, lim, today }) {
  if (info.date < today || (d.act_dates || []).includes(info.date)) return '';
  const { room, max } = roomOn(d, info.date, lim);
  const full = lim.primary_hours || 10, maxDay = lim.max_day_hours || 12;
  if (room >= maxDay) return '';
  const first = d.name.split(/\s+/)[0];
  const wd = parseISODate(info.date).toLocaleDateString('en-US', { weekday: 'long' });
  const wave = (String(v).match(/^\d{1,2}:\d{2} [AP]M/) || [])[0] || dayWaves(info)[0];
  const by = clockOutBy(waveMins(wave), room).by;
  const t = `${((Math.floor(by / 60) + 11) % 12) + 1}:${String(by % 60).padStart(2, '0')} ${by >= 720 ? 'PM' : 'AM'}`;
  const h = Math.floor(room * 2) / 2;   // whole or half hours, rounded down
  if (room <= 0.5) return html`<div class="dm-info warn"><b>No hours left on ${wd}.</b> Any work puts ${first} over ${max} hours in 7 days.</div>`;
  return html`<div class=${'dm-info ' + (room < full ? 'warn' : '')}>
    ${room < full
      ? html`<b>${first} can only work about ${h} hours on ${wd}</b> before going over ${max} hours in 7 days — not enough
          for a full route (${full}h). A split route works: back and clocked out by <b>${t}</b> (${wave} start).`
      : html`<b>Up to ${h} hours on ${wd}.</b> A full route fits, but a long day could go over ${max} hours —
          back and clocked out by <b>${t}</b> (${wave} start).`}</div>`;
}

// The 7 days ending the clicked day (Jose 2026-10-07): the 6 days before it, and that 7-day total
// if the driver works a full route that day — e.g. a backup day, "what if she's sent out?".
// Days not worked yet count their scheduled hours; days already worked count the real clock-out.
function SevenDays({ d, info, v, lim }) {
  const dh = d.day_hours || {}, iso = info.date;
  const at = (n) => toISODate(addDays(pd(iso), n));
  const r2 = (x) => Math.round(x * 100) / 100;
  let prior = 0;
  for (let k = 1; k <= 6; k++) prior += Number(dh[at(-k)] || 0);
  prior = r2(prior);
  const full = lim.primary_hours || 10, max = lim.max_7day_hours || 60;
  const worked = (d.act_dates || []).includes(iso), now = Number(dh[iso] || 0);
  const day = pd(iso).toLocaleDateString('en-US', { weekday: 'long' });
  const span = `${pd(at(-6)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} – ${pd(at(-1)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const tone = (t) => (t > max ? 'lv-bad' : t >= max - 6 ? 'lv-warn' : '');
  const k = cellInfo(v).kind;
  const line = worked
    ? html`Worked <b>${now}h</b> on ${day} → <b class=${tone(prior + now)}>${r2(prior + now)}h</b> in these 7 days`
    : html`With a ${full}h route on ${day}: <b class=${tone(prior + full)}>${r2(prior + full)}h</b> in 7 days${
        k === 'bk' ? html` <span class="muted">(as a backup: ${r2(prior + now)}h)</span>` : ''}`;
  return html`<div class="dm-seven">
    <div><b>${prior}h</b> in the 6 days before (${span})</div>
    <div>${line} <span class="muted">· max ${max}</span></div>
  </div>`;
}

// A comment on this day (Jose 2026-10-07): on any cell — a shift, Unavailable, an empty day.
function NoteBox({ note, busy, onSave }) {
  const [txt, setTxt] = useState(note ? note.text : '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setTxt(note ? note.text : ''); }, [note && note.text]);
  const save = async (t) => { setSaving(true); try { await onSave(t); } finally { setSaving(false); } };
  return html`<div class="dm-note">
    ${note ? html`<div class="dm-note-old">💬 ${note.text} <span class="muted">— ${note.by || '—'}${note.at ? ', ' + new Date(note.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''}</span></div>` : ''}
    <textarea rows="2" maxlength="500" placeholder="Add a comment about this day — everyone with the app sees it"
      value=${txt} onInput=${(e) => setTxt(e.target.value)}></textarea>
    <div class="row">
      <button class="small" disabled=${busy || saving || txt.trim() === (note ? note.text : '')} onClick=${() => save(txt)}>
        ${saving ? 'Saving…' : note ? 'Save changes' : 'Save comment'}</button>
      ${note ? html`<button class="link" disabled=${saving} onClick=${() => save('')}>Delete comment</button>` : ''}
    </div>
  </div>`;
}

// What one driver is doing on one day, and everything that can be done about it.
function CellMenu({ d, day, info, mark, busy, onClose, act, opt, fills, view, risk, note, onSaveNote }) {
  const v = (d.cells || {})[day] || '';
  const c = cellInfo(v);
  const kind = c.kind;
  const role = kind === 'road' ? 'road' : kind === 'bk' ? 'backup' : null;
  const first = d.name.split(/\s+/)[0];
  const date = parseISODate(info.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const lim = view.limits || {};
  const [mtime, setMtime] = useState('13:00');
  const [rideWith, setRideWith] = useState('');
  const free = info.open && (kind === 'empty' || kind === 'off');
  const duties = (opt && opt.duties) || {};
  // who drives a plain route that day — a trainer rides along with one of them
  const drivers = view.drivers.filter((x) => x.name !== d.name && cellInfo((x.cells || {})[day]).kind === 'road')
    .map((x) => ({ name: x.name, wave: cellInfo(x.cells[day]).top })).sort((a, b) => a.name.localeCompare(b.name));
  const duty = (k, extra) => act('duty', { name: d.name, day, kind: k, st: duties[k], ...extra });

  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card daymodal" role="dialog" aria-label=${`${d.name}, ${date}`}>
      <div class="dm-head">
        <div class="dm-who">
          <div class="dm-name">${d.name}</div>
          <div class="dm-date">${date}</div>
        </div>
        <div class="dm-now">${kind === 'empty' ? html`<span class="muted">Not scheduled</span>` : html`<${Block} v=${v} />`}</div>
        <button class="dm-x" aria-label="Close" onClick=${onClose}>×</button>
      </div>

      <div class="dm-stats">
        <div><b>${d.clock_hours ?? d.hours}h</b><span>this week${(d.act_dates || []).length
          ? html` · <span class="act-note" title="Real hours from Route Tracker's clock-outs for these days; planned hours for the rest">actual through ${new Date(d.act_dates[d.act_dates.length - 1] + 'T12:00').toLocaleDateString('en-US', { weekday: 'short' })}</span>` : ''}</span></div>
        <div class=${(d.max7 ?? 0) > (lim.max_7day_hours || 60) - 6 ? 'hot' : ''}><b>${d.max7 ?? '—'}h</b><span>most in any 7 days (max ${lim.max_7day_hours || 60})</span></div>
        <div class=${d.streak >= (lim.max_consecutive || 5) ? 'hot' : ''}><b>${d.streak}</b><span>days in a row (usual max ${lim.max_consecutive || 5})</span></div>
      </div>

      <${SevenDays} d=${d} info=${info} v=${v} lim=${lim} />
      ${risk && risk.hot.includes(info.date) ? html`<div class="dm-info warn dm-over"><${RiskInfo} d=${d} risk=${risk} iso=${info.date} /></div>` : ''}
      ${info.open && kind !== 'disp' && kind !== 'meet' && kind !== 'mark' ? html`<${HoursLeft} d=${d} info=${info} v=${v} lim=${lim} today=${todayISO()} />` : ''}
      ${kind === 'trainer' || kind === 'trainee' ? html`<div class="dm-info">${kind === 'trainer'
        ? html`<b>Trainer</b> — rides along with <b>${c.partner}</b> on the ${c.top} route.`
        : html`<b>Trainee</b> — drives the ${c.top} route with trainer <b>${c.partner}</b>.`}</div>` : ''}
      ${mark ? html`<div class="dm-info warn"><b>${c.top}</b>${mark.was ? ` — was a ${mark.was}` : ''}${mark.note ? html` · “${mark.note}”` : ''}</div>` : ''}
      ${!info.open ? html`<div class="dm-info">The station is closed this day.</div>` : ''}
      <div class="dm-sec">Comment</div>
      <${NoteBox} note=${note} busy=${busy} onSave=${onSaveNote} />

      ${role ? html`
        <div class="dm-sec">Change this shift</div>
        <div class="dm-grid">
          <${Act} icon="⇄" title="Give it to someone else" sub=${`Pick who takes this ${role === 'road' ? 'route' : 'backup'}`} busy=${busy}
            onClick=${() => act('move', { day, role, fromName: d.name })} />
          <${Act} icon="🕑" title="Change wave" sub="Move to another start time" busy=${busy}
            onClick=${() => act('wave', { day, name: d.name })} />
          ${role === 'road'
            ? html`<${Act} icon="↓" title="Make it a backup" sub="Same wave — the route stays open" busy=${busy}
                onClick=${() => act('role', { name: d.name, day, to: 'backup' })} />`
            : html`<${Act} icon="↑" title="Make it a route" sub="Checked like any new route" busy=${busy}
                onClick=${() => act('role', { name: d.name, day, to: 'road' })} />`}
        </div>
        <div class="dm-sec">${first} isn't coming</div>
        <div class="dm-grid">
          <${Act} icon="☎" title="Called out" sub="They called in — the slot opens" busy=${busy}
            onClick=${() => act('mark', { name: d.name, day, kind: 'callout' })} />
          <${Act} icon="✕" title="No-show" sub="Didn't show, didn't call" busy=${busy}
            onClick=${() => act('mark', { name: d.name, day, kind: 'noshow' })} />
          <${Act} icon="−" title="Remove the shift" sub="Leave the slot open" tone="dm-danger" busy=${busy}
            onClick=${() => act('remove', { day, role, fromName: d.name })} />
        </div>` : ''}

      ${kind === 'trainer' || kind === 'trainee' ? html`<div class="dm-grid one">
        <${Act} icon="−" title="End this training pair" sub=${kind === 'trainer' ? `${c.partner} drives alone; ${first} is off that day` : `${first} drives alone; ${c.partner} is off that day`}
          tone="dm-danger" busy=${busy} onClick=${() => act('unduty', { name: d.name, day })} /></div>` : ''}
      ${kind === 'disp' || kind === 'meet' ? html`<div class="dm-grid one">
        <${Act} icon="−" title=${kind === 'disp' ? 'Take off dispatch' : 'Take out of the meeting'} sub="The day becomes free"
          tone="dm-danger" busy=${busy} onClick=${() => act('unduty', { name: d.name, day })} /></div>` : ''}
      ${mark ? html`<div class="dm-grid one"><${Act} icon="↺" title="Clear this mark" sub="Doesn't put the shift back"
        busy=${busy} onClick=${() => act('clear', { name: d.name, day })} /></div>` : ''}

      ${free ? html`
        <div class="dm-sec">Put ${first} on a route</div>
        <${DayShifts} name=${d.name} info=${info} road=${opt ? opt.road : null} fills=${fills} busy=${busy}
          onPick=${(w) => act('wave-add', { name: d.name, day, wave: w, road: opt && opt.road })} />

        <div class="dm-sec">Or another duty</div>
        ${!opt ? html`<p class="muted"><${Spinner}/> Checking the rules…</p>` : html`<div class="dm-duties">
          <div class="dm-duty">
            <span class="lv-sw" style=${`background:${SHIFT_COLORS.trainer}`}>Trainer</span>
            ${duties.trainer && duties.trainer.status === 'blocked' ? html`<${RuleNote} st=${duties.trainer} first=${first} />` : html`
              <select value=${rideWith} onChange=${(e) => setRideWith(e.target.value)} aria-label="Ride along with">
                <option value="">Rides along with…</option>
                ${drivers.map((x) => html`<option value=${x.name}>${x.name} · ${x.wave}</option>`)}
              </select>
              <button class="small" disabled=${busy || !rideWith} onClick=${() => duty('trainer', { with_name: rideWith })}>Set trainer</button>
              <${RuleNote} st=${duties.trainer} first=${first} />`}
          </div>
          <div class="dm-duty">
            <span class="lv-sw" style=${`background:${SHIFT_COLORS.meet}`}>Meeting</span>
            ${duties.meeting && duties.meeting.status === 'blocked' ? html`<${RuleNote} st=${duties.meeting} first=${first} />` : html`
              <input type="time" value=${mtime} onInput=${(e) => setMtime(e.target.value)} aria-label="Meeting time" />
              <button class="small" disabled=${busy} onClick=${() => duty('meeting', { time: ampm(mtime) })}>Add ${ampm(mtime)} meeting</button>
              <${RuleNote} st=${duties.meeting} first=${first} />`}
          </div>
          <div class="dm-duty">
            <span class="lv-sw" style=${`background:${SHIFT_COLORS.disp}`}>Dispatch</span>
            ${duties.dispatch && duties.dispatch.status === 'blocked' ? html`<${RuleNote} st=${duties.dispatch} first=${first} />` : html`
              <button class="small" disabled=${busy} onClick=${() => duty('dispatch')}>Put on dispatch (${lim.dispatch_hours || 12}h)</button>
              <${RuleNote} st=${duties.dispatch} first=${first} />`}
          </div>
        </div>`}
        ${kind === 'empty' ? html`<div class="dm-grid one" style="margin-top:12px">
          <${Act} icon="☀" title=${`${first} asked for ${day} off`} sub="Marks the day off" busy=${busy}
            onClick=${() => act('mark', { name: d.name, day, kind: 'off' })} /></div>` : ''}` : ''}

      ${kind === 'disp' || kind === 'meet' || kind === 'trainer' || kind === 'trainee' || role || mark || free ? '' : html`<p class="muted">Nothing to change here.</p>`}
      ${busy ? html`<p class="muted" style="margin-top:10px"><${Spinner}/> Saving…</p>` : ''}
    </div>
  </div>`;
}

// Click on a name: the driver's week, each free day with its waves.
function WeekShifts({ d, view, opts, busy, onClose, onPick }) {
  const first = d.name.split(/\s+/)[0];
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>Give ${d.name} a shift</h3>
      <p class="hint">${d.clock_hours ?? d.hours}h this week · most in any 7 days ${d.max7 ?? '—'}h. Pick a wave on a free day —
        a full wave just gets one more route. To make a backup, click the shift in the table afterwards.</p>
      ${opts && opts.error ? html`<${Banner} kind="err">${opts.error.message}<//>` : ''}
      <div class="lv-week">
        ${view.days.filter((x) => x.open).map((info) => {
          const v = (d.cells || {})[info.day] || '';
          const k = cellInfo(v).kind;
          const dd = opts && opts.data ? opts.data.days.find((x) => x.day === info.day) : null;
          return html`<div class="lv-weekrow">
            <div class="lv-weekday"><b>${info.day}</b> <span class="muted">${shortDate(info.date)}</span></div>
            <div>${k !== 'empty' && k !== 'off'
              ? html`<div style="max-width:150px"><${Block} v=${v} /></div>`
              : html`<${DayShifts} compact name=${d.name} info=${info} road=${dd ? dd.road : null}
                  fills=${waveFills(view, info.day)} busy=${busy} onPick=${(w) => onPick(info.day, w, dd && dd.road)} />`}</div>
          </div>`;
        })}
      </div>
      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Close</button>
        ${busy ? html`<span><${Spinner}/> Saving…</span>` : ''}
      </div>
    </div>
  </div>`;
}

function MarkDialog({ req, busy, onClose, onSave }) {
  const [kind, setKind] = useState(req.kind);
  const [note, setNote] = useState('');
  return html`<div class="edit-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="edit-modal card">
      <h3>${req.name} — ${req.day}</h3>
      <p class="hint">Their shift that day comes off and the slot shows as <b>open</b>, so you can fill it.
        The day then counts as a day off for the rules.</p>
      ${MARKS.map(([k, label, sub]) => html`<label class="row lv-radio">
        <input type="radio" name="mk" checked=${kind === k} onChange=${() => setKind(k)} />
        <span><b>${label}</b> <span class="muted">${sub}</span></span></label>`)}
      <label class="fld" style="margin-top:10px"><span>Note (optional)</span>
        <input type="text" maxlength="200" value=${note} onInput=${(e) => setNote(e.target.value)}
          placeholder="e.g. sick, family emergency" style="width:100%" /></label>
      <div class="row" style="margin-top:12px">
        <button disabled=${busy} onClick=${onClose}>Cancel</button>
        <button class="primary" disabled=${busy} onClick=${() => onSave(kind, note)}>Save</button>
        ${busy ? html`<span><${Spinner}/> Saving…</span>` : ''}
      </div>
    </div>
  </div>`;
}

// "Who can work extra?" — every driver checked against the rules for one
// day and role, safest first.
function Finder({ view, finder, setFinder, ready, rev, busy, onPick }) {
  const [st, setSt] = useState(null);
  const days = view.days.filter((x) => x.open);
  const info = view.days.find((x) => x.day === finder.day);
  useEffect(() => {
    if (!ready || !finder.day) { setSt(null); return undefined; }
    let alive = true;
    setSt({ loading: true });
    liveRequest('candidates', { day: finder.day, role: finder.role }).then((m) => {
      if (alive) setSt(m.ok ? { list: m.data.candidates } : { error: m.error.message });
    });
    return () => { alive = false; };
  }, [ready, rev, finder.day, finder.role]);

  const open = info ? (finder.role === 'road' ? info.routes - info.routes_filled : info.backup - info.backup_filled) : 0;
  const list = (st && st.list) || [];
  const groups = [['ok', 'Can work — no rule breaks'], ['warn', 'Can work — breaks a company policy (flagged)'],
    ['confirm', '6 days in 7 / overtime — can work after a pop-up'],
    ['unavail', 'Asked for the day off — needs your confirmation'],
    ['blocked', 'Can\'t — compliance rule (12h a day, 60h in 7 days, 7 days in 7, clashes)']];
  const [showBlocked, setShowBlocked] = useState(false);
  return html`<div class="card" id="lv-finder">
    <h2>Who can work extra?</h2>
    <div class="row" style="margin:8px 0">
      <select value=${finder.day || ''} onChange=${(e) => setFinder({ ...finder, day: e.target.value })}>
        ${days.map((x) => html`<option value=${x.day}>${x.day} ${shortDate(x.date)}</option>`)}
      </select>
      <select value=${finder.role} onChange=${(e) => setFinder({ ...finder, role: e.target.value })}>
        <option value="road">a route</option><option value="backup">a backup</option>
      </select>
      ${info ? html`<span class=${open > 0 ? 'lv-open' : 'muted'}>${open > 0
        ? `${open} open ${finder.role === 'road' ? 'route' : 'backup'}${open === 1 ? '' : 's'} on ${finder.day}`
        : `${finder.day}'s ${finder.role === 'road' ? `${info.routes} routes` : `${info.backup} backups`} are all filled`}</span>` : ''}
    </div>
    ${!ready ? html`<p class="muted"><${Spinner}/> Loading the rules engine…</p>` : ''}
    ${st && st.loading ? html`<p class="muted"><${Spinner}/> Checking every driver…</p>` : ''}
    ${st && st.error ? html`<${Banner} kind="err">${st.error}<//>` : ''}
    ${groups.map(([status, label]) => {
      const g = list.filter((c) => c.status === status);
      if (!g.length) return '';
      if (status === 'blocked' && !showBlocked) {
        return html`<p class="muted"><button class="link" onClick=${() => setShowBlocked(true)}>Show the ${g.length} who can't (and why)</button></p>`;
      }
      return html`<div class="cand-group">
        <h4 class=${'cand-h ' + status}>${label} (${g.length})</h4>
        ${g.map((c) => {
          const meta = TIER_META[c.cls] || TIER_META.free;
          return html`<div class=${'cand ' + status}>
            <button class="cand-pick" disabled=${busy || status === 'blocked'}
              onClick=${() => onPick(c, open > 0)}>${status === 'blocked' ? '🔒 ' : '+ '}${c.name}</button>
            <span class="chip ${meta.chip}">${meta.short}</span>
            <span class="cand-hours"><b>${c.road_days.length + c.backup_days.length} days</b> · ${c.hours}h → ${c.new_hours}h</span>
            ${(c.reasons || []).length ? html`<div class="cand-why">${c.reasons.join('; ')}</div>` : ''}
            ${(c.notes || []).length ? html`<div class="cand-note">${c.notes.join('; ')}</div>` : ''}
          </div>`;
        })}
      </div>`;
    })}
  </div>`;
}

export function LiveBoard() {
  if (!canLive()) return html`<${NotHere} />`;
  return html`<${Board} />`;
}

function Board() {
  const [weeks, setWeeks] = useState(null);
  const [sel, setSel] = useState(null);
  const [data, setData] = useState(null);      // {meta, summary, engineJson, rev}
  const [rep, setRep] = useState(null);        // the engine's report for data.rev
  const [eng, setEng] = useState({ status: 'idle', rev: null, error: null });
  const [metaLive, setMetaLive] = useState(null);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [cell, setCell] = useState(null);      // {name, day}
  const [adder, setAdder] = useState(null);    // {name}
  const [waver, setWaver] = useState(null);    // {day, name}
  const [mover, setMover] = useState(null);    // {day, role, fromName}
  const [moverCands, setMoverCands] = useState(null);
  const [marker, setMarker] = useState(null);  // {name, day, kind}
  const [confirm, setConfirm] = useState(null);
  const [limit, setLimit] = useState(null);     // the overtime pop-up
  const [opts, setOpts] = useState(null);       // add_options for the driver whose day/week is open
  const [finder, setFinder] = useState({ day: null, role: 'road' });
  const [showLog, setShowLog] = useState(false);
  const [sortBy, setSortBy] = useState(readSort);   // 'tier' | 'name'
  const [q, setQ] = useState('');                   // name search
  const [pop, setPop] = useState(null);             // the over-60 card: {name, iso, left, top, up}
  const [notes, setNotes] = useState({});           // comments on shifts: {"<ISO day>|<name>": {text, by, at}}
  const [confirms, setConfirms] = useState({});     // "not in Route Tracker" answers
  const [actDocs, setActDocs] = useState({});       // Route Tracker's actual_hours docs {cur, prev}

  // async work reads the newest values through refs
  const R = useRef({});
  Object.assign(R.current, { sel, data, rep, eng, metaLive, busy });
  const saving = useRef(false);

  async function refreshWeeks(pick) {
    try {
      const ws = await liveWeeks(80);
      setWeeks(ws);
      if (pick) {
        const t = sundayOf(todayISO());
        setSel((ws.find((w) => w.week === t) || ws[0] || {}).week || null);
      }
    } catch (e) { setErr('Could not read the published weeks: ' + (e.message || e)); setWeeks([]); }
  }
  useEffect(() => { refreshWeeks(true); }, []);

  async function openWeek(week) {
    try {
      const d = await liveWeek(week);
      if (R.current.sel !== week) return;
      if (!d) { setErr('That week is no longer on the Live board.'); return; }
      const nd = { meta: d.meta, summary: JSON.parse(d.summary), engineJson: d.engine, rev: d.meta.rev };
      setData(nd); R.current.data = nd;
      setRep(null);
      setEng({ status: 'loading', rev: null, error: null });
      const r = await loadEngine(week, d.engine);
      if (R.current.sel !== week || R.current.data !== nd) return;
      setRep(r); R.current.rep = r;
      setEng({ status: 'ready', rev: nd.rev, error: null }); R.current.eng = { status: 'ready', rev: nd.rev };
    } catch (e) {
      setEng({ status: 'error', rev: null, error: e.message || String(e) });
    }
  }

  useEffect(() => {
    if (!sel) return undefined;
    setData(null); setRep(null); setLog([]); setErr(''); setMetaLive(null);
    setEng({ status: 'idle', rev: null, error: null });
    openWeek(sel);
    const un1 = watchLiveWeek(sel, (m) => setMetaLive(m));
    const un2 = watchLiveLog(sel, (l) => setLog(l));
    setNotes({}); setConfirms({}); setActDocs({});
    const unNotes = watchLiveNotes(sel, (n) => setNotes(n || {}));
    const unConf = watchLiveConfirms(sel, (c) => {
      setConfirms(c || {});
      // a "they worked" answer changed: reload so the hours count it
      const seen = ACT_LOADED[sel];
      if (!seen || workedSig(c) === seen.confirm) return;
      if (saving.current || !R.current.eng || R.current.eng.status !== 'ready') return;
      seen.confirm = workedSig(c);
      openWeek(sel);
    });
    // a clock-out in Route Tracker changed someone's real hours: reload so the limits use them
    const onActual = (which) => (doc) => {
      const seen = ACT_LOADED[sel];
      if (!seen || actualSig(doc) === seen[which]) return;
      if (saving.current || !R.current.eng || R.current.eng.status !== 'ready') return;
      seen[which] = actualSig(doc);
      toast('Hours updated from Route Tracker clock-outs.');
      openWeek(sel);
    };
    const un3 = watchActualHours(sel, onActual('cur'));
    const un4 = watchActualHours(prevISO(sel), onActual('prev'));
    const unA = watchActualHours(sel, (doc) => setActDocs((x) => ({ ...x, cur: doc })));
    const unB = watchActualHours(prevISO(sel), (doc) => setActDocs((x) => ({ ...x, prev: doc })));
    return () => { unNotes(); unConf(); unA(); unB(); un1(); un2(); un3(); un4(); };
  }, [sel]);

  // someone else saved this week: pull it in
  useEffect(() => {
    const d = R.current.data;
    if (!metaLive || !d || saving.current) return;
    if (metaLive.rev > d.rev) {
      toast(`${metaLive.by || 'Someone'} changed this week — showing the latest.`);
      openWeek(R.current.sel);
    }
  }, [metaLive && metaLive.rev]);

  // the finder starts on today (or the first open day)
  useEffect(() => {
    if (!data || finder.day) return;
    const days = (data.summary.days || []).filter((x) => x.open);
    const t = days.find((x) => x.date === todayISO()) || days.find((x) => x.date > todayISO()) || days[0];
    if (t) setFinder((f) => ({ ...f, day: t.day }));
  }, [data]);

  // One change, end to end: engine -> Firestore (+ change-log lines). The
  // engine must hold exactly the saved version first; a save that fails
  // (someone else saved first, or no signal) reloads the saved version so
  // nothing unsaved lingers on screen.
  async function run(op, payload) {
    const d = R.current.data;
    if (!d) return { ok: false, error: { kind: 'busy', message: 'The week is still loading.' } };
    if (R.current.busy) return { ok: false, error: { kind: 'busy', message: 'Still saving the last change…' } };
    setBusy(true); R.current.busy = true; saving.current = true;
    try {
      if (R.current.eng.status !== 'ready' || R.current.eng.rev !== d.rev) {
        const r0 = await loadEngine(R.current.sel, d.engineJson);
        setRep(r0); R.current.rep = r0;
        R.current.eng = { status: 'ready', rev: d.rev }; setEng({ status: 'ready', rev: d.rev, error: null });
      }
      const before = (R.current.rep && R.current.rep.edits) || [];
      const m = await liveRequest(op, payload);
      if (!m.ok) return m;
      let saved;
      try {
        saved = await saveWeek({ weekISO: R.current.sel, meta: d.meta, report: m.report, expectRev: d.rev,
          log: logLines(before, m.report.edits, KIND[op] || 'edit') });
      } catch (e) {
        const msg = e.code === 'conflict'
          ? `${e.message} The page now shows the latest version — make your change again if it's still needed.`
          : `Not saved — ${e.message || e}. Check the connection and try again.`;
        toast(msg, e.code === 'conflict' ? 'warn' : 'err');
        saving.current = false;
        await openWeek(R.current.sel);
        return { ok: false, error: { kind: 'save', message: msg } };
      }
      const nd = { meta: { ...d.meta, rev: saved.rev }, summary: summaryFromReport(m.report, d.meta),
        engineJson: saved.engine, rev: saved.rev };
      setData(nd); R.current.data = nd;
      setRep(m.report); R.current.rep = m.report;
      R.current.eng = { status: 'ready', rev: saved.rev }; setEng({ status: 'ready', rev: saved.rev, error: null });
      const lines = logLines(before, m.report.edits, KIND[op]);
      toast('Saved — ' + lines[lines.length - 1].text);
      return m;
    } catch (e) {
      return { ok: false, error: { kind: 'crash', message: e.message || String(e) } };
    } finally {
      setBusy(false); R.current.busy = false; saving.current = false;
      // a save from someone else that landed while ours was in flight
      const ml = R.current.metaLive, dd = R.current.data;
      if (ml && dd && ml.rev > dd.rev) openWeek(R.current.sel);
    }
  }
  const req = (op, p) => (MUT.has(op) ? run(op, p) : liveRequest(op, p));

  // rule check of every day for the driver whose cell / week is open
  const optName = (cell && cell.name) || (adder && adder.name) || null;
  useEffect(() => {
    if (!optName || !data) { setOpts(null); return undefined; }
    let alive = true;
    setOpts({ loading: true });
    const go = () => liveRequest('add_options', { name: optName }).then((m) => {
      if (alive) setOpts(m.ok ? { data: m.data } : { error: m.error });
    });
    if (R.current.eng.status === 'ready') go();
    else { const t = setInterval(() => { if (R.current.eng.status === 'ready') { clearInterval(t); go(); } }, 300);
      return () => { alive = false; clearInterval(t); }; }
    return () => { alive = false; };
  }, [optName, data && data.rev, eng.status]);

  // A route in a chosen wave, through whatever pop-ups it needs.
  function addWave(name, day, wave, road) {
    runConfirmed({ name, day, role: 'road', unavReasons: road && road.status === 'unavail' ? road.reasons : null,
      limits: road && road.limits }, setConfirm, setLimit, async (flags) => {
      const m = await run('apply_add', { name, day, role: 'road', wave, ...flags });
      if (m.ok) { setCell(null); setAdder(null); } else toast(m.error.message, 'err');
    });
  }

  // Any edit; if the engine asks for a pop-up first, show it and try again.
  async function runAsking(op, payload, who) {
    const m = await run(op, payload);
    if (m.ok || !m.error) return m;
    if (m.error.kind === 'needs_confirm') {
      setConfirm({ ...who, reasons: [m.error.message.replace(/ Confirm the override first\.$/, '')],
        run: () => runAsking(op, { ...payload, confirm_unavailable: true }, who) });
    } else if (m.error.kind === 'needs_limits') {
      setLimit({ ...who, limits: m.error.limits || [], run: () => runAsking(op, { ...payload, confirm_limits: true }, who) });
    } else toast(m.error.message, 'err');
    return m;
  }

  // candidates for "give this shift to someone else"
  useEffect(() => {
    if (!mover) { setMoverCands(null); return undefined; }
    let alive = true;
    setMoverCands({ loading: true, error: null, list: null });
    liveRequest('candidates', { day: mover.day, role: mover.role, from_name: mover.fromName }).then((m) => {
      if (alive) setMoverCands(m.ok ? { loading: false, error: null, list: m.data.candidates } : { loading: false, error: m.error, list: null });
    });
    return () => { alive = false; };
  }, [mover]);

  function moveTo(toName) {
    const c = toName && moverCands && moverCands.list ? moverCands.list.find((x) => x.name === toName) : null;
    const go = async (flags) => {
      const m = await run('apply', { day: mover.day, role: mover.role, from_name: mover.fromName,
        to_name: toName, ...flags });
      if (m.ok) setMover(null);
      else setMoverCands((s) => ({ ...(s || {}), loading: false, error: m.error }));
    };
    if (!c) { go({}); return; }
    runConfirmed({ name: toName, day: mover.day, role: mover.role,
      unavReasons: c.status === 'unavail' ? c.reasons : null, limits: c.limits }, setConfirm, setLimit, go);
  }

  // a pick from "Who can work extra?"
  function finderPick(c, hasOpen) {
    const { day, role } = finder;
    // a full day just gets one more route (Jose 2026-10-06: Amazon may have
    // handed out routes the app doesn't know yet) — the change log says so
    runConfirmed({ name: c.name, day, role, unavReasons: c.status === 'unavail' ? c.reasons : null, limits: c.limits },
      setConfirm, setLimit, async (flags) => {
        const m = hasOpen ? await run('apply', { day, role, to_name: c.name, ...flags })
          : await run('apply_add', { name: c.name, day, role, ...(role === 'road' ? { extra_route: true } : {}), ...flags });
        if (!m.ok) toast(m.error.message, 'err');
      });
  }

  async function cellAct(what, p) {
    if (what !== 'wave-add' && what !== 'duty') setCell(null);
    if (what === 'move') setMover(p);
    else if (what === 'wave') setWaver(p);
    else if (what === 'mark') setMarker(p);
    else if (what === 'add') setAdder(p);
    else if (what === 'wave-add') addWave(p.name, p.day, p.wave, p.road);
    else if (what === 'role') runAsking('set_role', p, { name: p.name, day: p.day, role: p.to === 'road' ? 'road' : 'backup' });
    else if (what === 'unduty') { const m = await run('clear_duty', p); if (!m.ok) toast(m.error.message, 'err'); }
    else if (what === 'duty') {
      const { st, ...payload } = p;
      runConfirmed({ name: p.name, day: p.day, role: p.kind, unavReasons: st && st.status === 'unavail' ? st.reasons : null,
        limits: st && st.limits }, setConfirm, setLimit, async (flags) => {
        const m = await run('set_duty', { ...payload, ...flags });
        if (m.ok) setCell(null); else toast(m.error.message, 'err');
      });
    }
    else if (what === 'remove') {
      const m = await run('apply', { day: p.day, role: p.role, from_name: p.fromName });
      if (!m.ok) toast(m.error.message, 'err');
    } else if (what === 'clear') {
      const m = await run('clear_mark', p);
      if (!m.ok) toast(m.error.message, 'err');
    }
  }

  async function downloadXlsx() {
    if (R.current.eng.status !== 'ready') { toast('The engine is still loading — try again in a few seconds.', 'warn'); return; }
    const m = await liveRequest('export_xlsx', {});
    if (!m.ok || !m.xlsx) { toast(m.error ? m.error.message : 'No workbook came back.', 'err'); return; }
    download(m.xlsx, `Week-${data.meta.num}-Schedule.xlsx`, XLSX_MIME);
  }

  // ------------------------------------------------------------- render --
  if (weeks === null) return html`<div class="card"><${Spinner}/> Loading the published weeks…</div>`;
  if (!weeks.length) {
    return html`<div class="card hero">
      <div class="hero-ico">${Icon('live', 24)}</div>
      <h2>No published weeks yet</h2>
      <p class="hint">Build a schedule, then press <b>Publish to the Live board</b> on the Build step. The week then
        lives here: everyone with the Schedule Builder can work it during the week, and every change is logged.</p>
      ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
      <button class="accent" onClick=${() => { setState({ route: 'wizard' }); setWizard({ step: 4 }); }}>Go to Build ${Icon('arrow', 16)}</button>
    </div>`;
  }

  const idx = weeks.findIndex((w) => w.week === sel);
  const thisWeek = sundayOf(todayISO());
  const picker = html`<div class="card lv-head">
    <div class="row">
      <button class="small" disabled=${idx >= weeks.length - 1} title="Older week" onClick=${() => setSel(weeks[idx + 1].week)}>◀</button>
      <select value=${sel || ''} onChange=${(e) => setSel(e.target.value)}>
        ${weeks.map((w) => html`<option value=${w.week}>${w.label || w.week}${w.week === thisWeek ? ' — this week' : w.week > thisWeek ? ' — upcoming' : ''}</option>`)}
      </select>
      <button class="small" disabled=${idx <= 0} title="Newer week" onClick=${() => setSel(weeks[idx - 1].week)}>▶</button>
      <span class="muted lv-pub">${data ? `Published by ${data.meta.publishedBy || '—'} · last change by ${data.meta.by || '—'}` : ''}</span>
    </div>
  </div>`;

  if (!data) {
    return html`<div>${picker}
      ${err ? html`<${Banner} kind="err">${err}<//>` : html`<div class="card"><${Spinner}/> Loading the week…</div>`}</div>`;
  }

  const view = rep ? summaryFromReport(rep, data.meta) : data.summary;
  const ready = eng.status === 'ready' && eng.rev === data.rev;
  const today = todayISO();
  const tday = view.days.find((x) => x.date === today);
  const lim = view.limits || {};
  const openRoutes = view.days.filter((x) => x.open).reduce((a, x) => a + Math.max(0, x.routes - x.routes_filled), 0);
  const openBk = view.days.filter((x) => x.open).reduce((a, x) => a + Math.max(0, x.backup - x.backup_filled), 0);
  const byName = Object.fromEntries(view.drivers.map((x) => [x.name, x]));
  const markOf = (name, day) => (view.marks || []).find((x) => x.name === name && x.day === day);
  // search + sort: by tier (Top/Solid first, as the builder groups them) or A-Z
  const shown = view.drivers.filter((x) => !q.trim() || fold(x.name).includes(fold(q.trim())));
  const groups = sortBy === 'name'
    ? [{ key: 'all', rows: shown.slice().sort((a, b) => a.name.localeCompare(b.name)) }]
    : TIER_ORDER.map((t) => ({ key: t, meta: TIER_META[t], rows: shown.filter((x) => x.cls === t) }))
      .filter((g) => g.rows.length);
  const todayCount = tday ? view.drivers.reduce((a, x) => {
    const k = cellInfo((x.cells || {})[tday.day]).kind;
    return a + (k === 'road' || k === 'trainee' ? 1 : 0);
  }, 0) : null;

  const max7Lim = lim.max_7day_hours || 60;
  const hoursCls = (h) => (h > max7Lim ? 'lv-bad' : lim.weekly_hours_cap && h > lim.weekly_hours_cap ? 'lv-warn' : '');
  const max7Cls = (h) => (h > max7Lim ? 'lv-bad' : h >= max7Lim - 6 ? 'lv-warn' : '');
  // "Last 7d" like Amazon: the 7 days ending today, or ending the week's last
  // day for a week that's over (an upcoming week shows its busiest 7 days)
  const lastDay = view.days[view.days.length - 1].date;
  const endISO = today < view.days[0].date ? null : today > lastDay ? lastDay : today;
  const streakCls = (n) => (n > (lim.max_consecutive || 5) ? 'lv-bad' : n === (lim.max_consecutive || 5) ? 'lv-warn' : '');
  const daysCls = (n) => (n > (lim.max_worked_days || 5) ? 'lv-bad' : n === (lim.max_worked_days || 5) ? 'lv-warn' : '');
  const maxD7 = lim.max_days_in_7 || 5;
  const nCols = view.days.length + 5;
  // over the 7-day max: the upcoming days that cause it shake; hover one for what and how to fix
  // and the days that would make 6 worked days in 7 (a safeguard: the rules lock that)
  const risks = Object.fromEntries(view.drivers.map((x) => {
    const hours = overRisk(x, view.days, today, lim), run = runRisk(x, view.days, today, lim);
    if (hours) hours.backupH = lim.backup_hours || 2;
    return [x.name, hours || run ? { hours, run, hot: [...new Set([...(hours ? hours.hot : []), ...(run ? run.hot : [])])] } : null];
  }));
  const showPop = (e, name, iso) => {
    const b = e.currentTarget.getBoundingClientRect();
    setPop({ name, iso, left: Math.max(8, Math.min(b.left, window.innerWidth - 392)), top: b.bottom + 6,
      up: b.bottom + 340 > window.innerHeight ? b.top - 6 : null });
  };
  const goFind = (day, role) => {
    setFinder({ day, role });
    setTimeout(() => { const el = document.getElementById('lv-finder'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }, 30);
  };
  const canUndo = ready && rep && rep.can_undo;

  return html`<div>
    ${picker}

    <div class="stats">
      <div class="stat"><div class="big">${todayCount == null ? '—' : todayCount}</div>
        <div class="muted">${tday ? `on routes today (${tday.day})` : 'not this week'}</div></div>
      <div class="stat"><div class=${'big' + (openRoutes ? ' lv-bad' : '')}>${openRoutes}</div><div class="muted">open routes this week</div></div>
      <div class="stat"><div class=${'big' + (openBk ? ' lv-warnc' : '')}>${openBk}</div><div class="muted">open backups</div></div>
      <div class="stat"><div class="big">${log.length}</div><div class="muted">changes logged</div></div>
    </div>

    ${eng.status === 'error' ? html`<${Banner} kind="err">The rules engine didn't load: ${eng.error}
      <div><button class="small" onClick=${() => openWeek(sel)}>Try again</button></div><//>` : ''}
    ${(view.infeasible || []).length ? html`<${Banner} kind="warn"><b>Open slots:</b>
      <ul>${view.infeasible.map((l) => {
        let m = l.match(/P1 INFEASIBLE (\w+)/);
        const slot = m ? { day: m[1], role: 'road' } : (m = l.match(/P2 SHORT (\w+)/)) ? { day: m[1], role: 'backup' } : null;
        return html`<li>${openText(l)}${slot ? html` <button class="small" onClick=${() => goFind(slot.day, slot.role)}>Find someone…</button>` : ''}</li>`;
      })}</ul><//>` : ''}
    <${MissingCheck} week=${sel} missing=${missingDays(data.summary, actualList(actDocs.prev, actDocs.cur), confirms, today)} />
    <${RuleProblems} lines=${view.errors || []} />
    ${(view.overridden || []).length ? html`<details class="banner warn"><summary><b>${view.overridden.length} approved override${view.overridden.length === 1 ? '' : 's'}</b></summary>
      <ul>${view.overridden.map((l) => html`<li>${translateOverride(l)}</li>`)}</ul></details>` : ''}

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2>${data.meta.label}</h2>
          <p class="hint" style="margin-bottom:0">Click any day to change it — call-outs, moves, extra shifts. Click a name to give that
            driver another shift. Hours are scheduled hours (route ${lim.primary_hours || 10}h, backup ${lim.backup_hours || 2}h).
            ${!ready && eng.status !== 'error' ? html` <span class="muted"><${Spinner}/> loading the rules engine…</span>` : ''}</p>
        </div>
        <div class="row">
          ${canUndo ? html`<button class="small" disabled=${busy} onClick=${async () => { const m = await run('undo', {}); if (!m.ok) toast(m.error.message, 'err'); }}>Undo my last change</button>` : ''}
          <button class="small" disabled=${!ready} onClick=${downloadXlsx}>${Icon('download', 15)} Workbook</button>
          <button class="small" onClick=${() => download(new TextEncoder().encode(driverCsv(view, data.meta.label)).buffer,
            `Week-${data.meta.num}-Driver-Notices.csv`, 'text/csv')}>${Icon('download', 15)} Driver notices</button>
        </div>
      </div>

      <div class="row lv-tools">
        <input type="search" placeholder="Search a driver…" value=${q} onInput=${(e) => setQ(e.target.value)}
          aria-label="Search a driver by name" />
        <div class="seg" role="group" aria-label="Sort drivers">
          <button class=${sortBy === 'tier' ? 'on' : ''} onClick=${() => { setSortBy('tier'); saveSort('tier'); }}>By tier</button>
          <button class=${sortBy === 'name' ? 'on' : ''} onClick=${() => { setSortBy('name'); saveSort('name'); }}>A–Z</button>
        </div>
        ${q.trim() ? html`<span class="muted">${shown.length} of ${view.drivers.length} drivers</span>` : ''}
      </div>

      <div class="scroll-x lv-wrap"><table class="lv-grid">
        <thead><tr>
          <th class="lv-namecol">Driver</th>
          ${view.days.map((x) => html`<th class=${(x.date === today ? 'today ' : x.date < today ? 'past ' : '') + (x.open ? '' : 'closed')}>
            ${x.day} <span class="lv-date">${shortDate(x.date)}</span>
            ${x.open ? html`<div class="lv-fill">
              <span class=${x.routes_filled < x.routes ? 'lv-bad' : ''} title="routes filled / needed">${x.routes_filled}/${x.routes}</span>
              <span class=${x.backup_filled < x.backup ? 'lv-warnc' : ''} title="backups filled / needed"> · bk ${x.backup_filled}/${x.backup}</span></div>`
              : html`<div class="lv-fill">closed</div>`}</th>`)}
          <th title="On the clock this week (scheduled)">Week</th>
          <th title=${`Most hours on the clock in any 7 days in a row, last week included (max ${max7Lim}h). A backup counts 2h; "if sent out" counts each backup day still ahead as a full route.`}>Max 7d</th>
          <th title=${`Days worked this week. Usual max ${maxD7} in any 7 days in a row — last week counts ("in 7d" shows it when last week adds to it); a 6th needs the pop-up.`}>Days</th>
          <th title=${`Longest run of days in a row, last week included (max ${lim.max_consecutive || 5})`}>In a row</th>
        </tr></thead>
        <tbody>${!shown.length ? html`<tr><td colspan=${nCols} class="muted" style="text-align:left">
            No driver matches “${q}”.</td></tr>` : ''}
          ${groups.map((g) => html`
            ${g.meta ? html`<tr class="tier-sep"><td colspan=${nCols}><span class="chip ${g.meta.chip}">${g.meta.label}</span>
              <span class="muted"> · ${g.rows.length}</span></td></tr>` : ''}
            ${g.rows.map((x) => {
              const nWorked = (x.worked_dates || []).length;
              const tm = TIER_META[x.cls] || TIER_META.free;
              return html`<tr>
                <td class="lv-namecol"><button class="link lv-name" title=${'Give ' + x.name + ' a shift'}
                  onClick=${() => setAdder({ name: x.name })}>${x.name}</button>
                  ${sortBy === 'name' ? html` <span class="chip ${tm.chip} tier-mini">${tm.short}</span>` : ''}
                  ${(x.helper_days || []).length ? html` <span class="chip trainer-chip" title="Trains a new hire this week">Trainer</span>` : ''}
                  <div class="lv-sub">Week: ${x.clock_hours ?? x.hours}h${endISO && x.day_hours
                    ? html` · <span class=${max7Cls(last7(x.day_hours, endISO))}>Last 7d: ${last7(x.day_hours, endISO)}h</span>` : ''}</div></td>
                ${view.days.map((dd) => {
                  const v = (x.cells || {})[dd.day] || '';
                  const c = cellInfo(v);
                  const hot = risks[x.name] && risks[x.name].hot.includes(dd.date);
                  const note = notes[dd.date + '|' + x.name];
                  return html`<td class=${'lv-cell k-' + c.kind + (dd.date === today ? ' today' : '') + (dd.open ? '' : ' closed') + (hot ? ' lv-over' : '')}
                    title=${hot ? undefined : (note ? `💬 ${note.text} — ${note.by || ''}\n` : '') + (c.partner ? `${v} — ${c.kind === 'trainer' ? 'training' : 'trainer'}: ${c.partner}` : v || (dd.open ? 'Not scheduled — click for options' : 'Closed'))}
                    onMouseEnter=${hot ? (e) => showPop(e, x.name, dd.date) : undefined}
                    onMouseLeave=${hot ? () => setPop(null) : undefined}
                    onClick=${dd.open || note ? () => { setPop(null); setCell({ name: x.name, day: dd.day }); } : undefined}><${Block} v=${v} />${
                      note ? html`<span class="lv-notedot" aria-label="Has a comment">💬</span>` : ''}</td>`;
                })}
                <td class=${hoursCls(x.clock_hours ?? x.hours)}>${x.clock_hours ?? x.hours}h</td>
                <td class=${max7Cls(x.max7 ?? 0)}>${x.max7 ?? '—'}${x.max7 != null ? 'h' : ''}${(() => {
                  const ifs = max7IfSent(x, view.days, today, lim);
                  return ifs == null ? '' : html`<div class=${'lv-ifsent ' + max7Cls(ifs)}
                    title="If every backup day still ahead becomes a full route">if sent out: ${ifs}h</div>`;
                })()}</td>
                <td class=${daysCls(nWorked)}>${nWorked}${(x.max_days7 ?? 0) > nWorked ? html`<div class=${'lv-ifsent' + (x.max_days7 > maxD7 ? ' lv-bad' : '')}
                  title="Most days worked in any 7 days in a row, last week included">${x.max_days7} in 7d</div>` : ''}</td>
                <td class=${streakCls(x.streak)}>${x.streak}</td>
              </tr>`;
            })}`)}</tbody>
      </table></div>
      <div class="lv-legend">
        ${Object.entries(WAVE_COLORS).map(([w, bg]) => html`<span class="lv-sw" style=${`background:${bg}`}>${w}</span>`)}
        <span class="lv-sw" style=${`background:${WAVE_COLORS['10:25']}`}>10:25 <small>Backup</small></span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.trainer}`}>Trainer</span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.disp}`}>Dispatch</span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.meet}`}>Meeting</span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.off}`}>Unavailable</span>
        <span class="lv-sw" style=${`background:${SHIFT_COLORS.mark}`}>Called out / No-show</span>
      </div>
      ${pop && risks[pop.name] && byName[pop.name] ? html`<div class="lv-pop" style=${`left:${pop.left}px;` + (pop.up != null
        ? `top:${pop.up}px;transform:translateY(-100%)` : `top:${pop.top}px`)}><${RiskInfo} d=${byName[pop.name]} risk=${risks[pop.name]} iso=${pop.iso} /></div>` : ''}
      <p class="hint">A shaking day would put that driver over ${max7Lim}h in 7 days or at ${maxD7 + 1} days worked in 7 — hover it to see why and how to fix it.
        Hours are scheduled on-the-clock hours. Orange = at or near a limit, red = over it.
        Locked: 12h in a day, ${max7Lim}h in any 7 days, 7 days worked in 7. A ${maxD7 + 1}th day in 7 (last week counts)
        or overtime goes through after a pop-up — that driver's days then shake until it's fixed.</p>
    </div>

    <${Finder} view=${view} finder=${finder} setFinder=${setFinder} ready=${ready} rev=${data.rev} busy=${busy}
      onPick=${finderPick} />

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>Change log</h2>
        <button class="small" onClick=${() => setShowLog(!showLog)}>${showLog ? 'Show the last 8' : `Show all ${log.length}`}</button>
      </div>
      ${!log.length ? html`<p class="muted">No changes yet.</p>` : html`<ul class="lv-log">
        ${(showLog ? log : log.slice(0, 8)).map((l) => html`<li class=${'k-' + l.kind}>
          <span class="lv-when">${when(l.at)}</span> <b>${l.by || '—'}</b> — ${l.text}</li>`)}</ul>`}
    </div>

    ${cell && byName[cell.name] ? html`<${CellMenu} d=${byName[cell.name]} day=${cell.day}
      info=${view.days.find((x) => x.day === cell.day)} mark=${markOf(cell.name, cell.day)} busy=${busy}
      opt=${opts && opts.data && opts.data.name === cell.name ? (opts.data.days.find((x) => x.day === cell.day) || null) : null}
      fills=${waveFills(view, cell.day)} view=${view} risk=${risks[cell.name]}
      note=${notes[(view.days.find((x) => x.day === cell.day) || {}).date + '|' + cell.name]}
      onSaveNote=${async (t) => {
        try { await saveLiveNote(sel, cell.name, view.days.find((x) => x.day === cell.day).date, t); toast(t.trim() ? 'Comment saved' : 'Comment deleted'); }
        catch (e) { toast('Could not save the comment: ' + (e.message || e), 'err'); }
      }}
      onClose=${() => setCell(null)} act=${cellAct} />` : ''}
    ${marker ? html`<${MarkDialog} req=${marker} busy=${busy} onClose=${() => setMarker(null)}
      onSave=${async (kind, note) => { const m = await run('apply_mark', { ...marker, kind, note }); if (m.ok) setMarker(null); else toast(m.error.message, 'err'); }} />` : ''}
    ${mover ? html`<${SlotEditor} editor=${mover} cands=${moverCands} busy=${busy}
      onPick=${(n) => moveTo(n)} onClose=${() => setMover(null)}
      onRemove=${async () => { const m = await run('apply', { day: mover.day, role: mover.role, from_name: mover.fromName }); if (m.ok) setMover(null); }} />` : ''}
    ${waver ? html`<${WaveEditor} day=${waver.day} name=${waver.name} req=${req}
      onClose=${() => setWaver(null)} onApplied=${() => setWaver(null)} />` : ''}
    ${adder && byName[adder.name] ? html`<${WeekShifts} d=${byName[adder.name]} view=${view} busy=${busy}
      opts=${opts && (opts.error || (opts.data && opts.data.name === adder.name)) ? opts : null}
      onClose=${() => setAdder(null)} onPick=${(day, w, road) => addWave(adder.name, day, w, road)} />` : ''}
    ${confirm ? html`<${ConfirmOverride} req=${confirm} onCancel=${() => setConfirm(null)}
      onConfirm=${() => { const q = confirm; setConfirm(null); q.run(); }} />` : ''}
    ${limit ? html`<${LimitConfirm} req=${limit} onCancel=${() => setLimit(null)}
      onConfirm=${() => { const q = limit; setLimit(null); q.run(); }} />` : ''}
  </div>`;
}

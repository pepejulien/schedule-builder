// The two hard limits a schedule must never break, checked the same way everywhere
// (2026-10-07): over the 7-day hours max, and 7 days in a row. Used by the Live board and
// by the Vehicle Assigner (it imports this file from /schedule/app/live/limits.js), so this
// file must not import anything but ../lib/weeks.js.
import { parseISODate, toISODate, addDays } from '../lib/weeks.js';

// a shift that drives (a route, a trainee, a trainer riding along) — not a backup, meeting or mark
const isDrive = (v) => /^\d{1,2}:\d{2} [AP]M/.test(String(v || '')) && !/Backup|meeting/i.test(String(v || ''));

// Route Tracker's actual-hours docs -> one entry per driver (both weeks merged), the shape
// runner._apply_actual takes: [{name, keys, tid, days: {ISO: hours}}].
export function actualList(...docs) {
  const by = new Map();
  for (const doc of docs) for (const [id, d] of Object.entries((doc && doc.drivers) || {})) {
    const cur = by.get(id) || { name: d.name, keys: d.keys || [], tid: d.tid || '', days: {} };
    Object.assign(cur.days, d.days || {});
    by.set(id, cur);
  }
  return [...by.values()];
}
// "first|last" - the same key Route Tracker sends, for matching a summary's names (Today page)
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
export function flKey(name) {
  const t = String(name || '').toLowerCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  if (t.length > 2 && SUFFIX.has(t[t.length - 1])) t.pop();
  return t.length > 1 ? `${t[0]}|${t[t.length - 1]}` : (t[0] || '');
}

// The Today page reads the saved summary (no engine): lay the actual hours over it so the
// watch list counts what was really worked. Same matching as the engine: shared names skipped.
export function mergeActual(summary, list) {
  if (!summary || !list || !list.length) return summary;
  const byKey = new Map(), dup = new Set();
  for (const a of list) for (const k of new Set([flKey(a.name), ...(a.keys || [])])) {
    if (!k) continue;
    if (byKey.has(k) && byKey.get(k) !== a) dup.add(k);
    byKey.set(k, a);
  }
  const dates = (summary.days || []).map((d) => d.date);
  const start = dates[0];
  const drivers = (summary.drivers || []).map((d) => {
    const k = flKey(d.name);
    const a = dup.has(k) ? null : byKey.get(k);
    if (!a) return d;
    const day_hours = { ...(d.day_hours || {}), ...a.days };
    const clock_hours = Object.entries(day_hours).filter(([k2]) => k2 >= start).reduce((t, [, h]) => t + Number(h || 0), 0);
    let max7 = 0;
    for (const end of dates) {
      let t = 0;
      for (let i = 0; i < 7; i++) t += Number(day_hours[toISODate(addDays(parseISODate(end), -i))] || 0);
      max7 = Math.max(max7, t);
    }
    const act_dates = Object.keys(a.days).filter((x) => dates.includes(x) && Number(a.days[x])).sort();
    // a real shift on an unscheduled day counts as worked (days in a row, days this week)
    const worked = [...new Set([...(d.worked_dates || []), ...act_dates])].sort();
    let run = 0, best = 0;
    for (const x of dates) { run = worked.includes(x) ? run + 1 : 0; best = Math.max(best, run); }
    return { ...d, day_hours, clock_hours: Math.round(clock_hours * 100) / 100, max7: Math.round(max7 * 100) / 100,
      act_dates, worked_dates: worked, streak: Math.max(d.streak || 0, best) };
  });
  return { ...summary, drivers };
}

// What actual hours each loaded week used (live board compares, and reloads when they change).

// Over the 7-day max (2026-10-07): the 7-day stretches touching this week that go over, the
// upcoming days that cause it (they shake on the Live board), and every one-change fix,
// each checked by recounting the hours. Days already worked (past, or a Route Tracker
// clock-out) can't be changed, so they never shake and are never offered as a fix.
// d = a summary driver {name, cells, day_hours, act_dates}; days = summary.days; null = fine.
export function overRisk(d, days, today, lim) {
  const max = lim.max_7day_hours || 60, bkH = lim.backup_hours || 2;
  const dh = d.day_hours || {};
  const sh = (iso, n) => toISODate(addDays(parseISODate(iso), n));
  const r2 = (x) => Math.round(x * 100) / 100;
  const first = days[0].date, last = days[days.length - 1].date;
  // only stretches that still reach today or later: one that ended yesterday can't be changed
  const starts = [];
  for (let i = -6; sh(first, i) <= last; i++) if (sh(first, i + 6) >= today) starts.push(sh(first, i));
  if (!starts.length) return null;
  const windows = (h) => starts.map((s) => {
    let t = 0;
    for (let k = 0; k < 7; k++) t += Number(h[sh(s, k)] || 0);
    return { start: s, end: sh(s, 6), total: r2(t) };
  });
  const worst = (h) => Math.max(...windows(h).map((w) => w.total));
  const over = windows(dh).filter((w) => w.total > max + 0.005);
  if (!over.length) return null;
  const act = new Set(d.act_dates || []);
  const dayOf = (iso) => (days.find((x) => x.date === iso) || {}).day;
  const hot = days.map((x) => x.date).filter((iso) => iso >= today && !act.has(iso) && Number(dh[iso] || 0) > 0
    && over.some((w) => iso >= w.start && iso <= w.end));
  const fixes = [];
  for (const iso of hot) {
    const off = { ...dh, [iso]: 0 };
    const w0 = worst(off);
    if (w0 > max + 0.005) continue;            // even a day off there isn't enough
    fixes.push({ kind: 'off', dates: [iso], worst: w0 });
    if (isDrive((d.cells || {})[dayOf(iso)]) && dh[iso] > bkH) {
      const w1 = worst({ ...dh, [iso]: bkH });
      if (w1 <= max + 0.005) fixes.push({ kind: 'backup', dates: [iso], worst: w1 });
    }
    // the longest that day can be: the max minus the rest of each stretch holding it
    const cap = Math.floor(Math.min(...windows(off).filter((w) => iso >= w.start && iso <= w.end)
      .map((w) => max - w.total)) * 10) / 10;
    if (cap >= 1 && cap < dh[iso]) fixes.push({ kind: 'short', dates: [iso], hours: cap, worst: worst({ ...dh, [iso]: cap }) });
  }
  if (!fixes.length) {                          // no single change works: two days off
    for (let i = 0; i < hot.length; i++) {
      for (let j = i + 1; j < hot.length; j++) {
        const w = worst({ ...dh, [hot[i]]: 0, [hot[j]]: 0 });
        if (w <= max + 0.005) fixes.push({ kind: 'off2', dates: [hot[i], hot[j]], worst: w });
      }
    }
  }
  const top = over.reduce((a, w) => (w.total > a.total ? w : a));
  const breakdown = [];
  for (let k = 0; k < 7; k++) {
    const iso = sh(top.start, k);
    if (Number(dh[iso] || 0) > 0) breakdown.push({ date: iso, h: r2(Number(dh[iso])), done: iso < today || act.has(iso), hot: hot.includes(iso) });
  }
  return { max, over, hot, fixes, breakdown };
}

// 7 days in a row (2026-10-07): locked by the rules, so this should never show — a safeguard.
// Worked days = any day with hours or on the worked list (last week's tail included). Flags
// runs of 7+ that still reach today or later; the upcoming days in them shake, and each fix is
// a day off that breaks every such run (two days off if one isn't enough). null = fine.
export function runRisk(d, days, today, lim, maxRun = 6) {
  const dh = d.day_hours || {};
  const sh = (iso, n) => toISODate(addDays(parseISODate(iso), n));
  const first = days[0].date, last = days[days.length - 1].date;
  const span = [];
  for (let i = -maxRun; sh(first, i) <= last; i++) span.push(sh(first, i));
  const runsOf = (w) => {
    const out = [];
    let cur = [];
    for (const iso of span) {
      if (w.has(iso)) cur.push(iso);
      else { if (cur.length) out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out.filter((r) => r.length > maxRun && r[r.length - 1] >= today);
  };
  const worked = new Set([...Object.keys(dh).filter((k) => Number(dh[k]) > 0), ...(d.worked_dates || [])]);
  const bad = runsOf(worked);
  if (!bad.length) return null;
  const act = new Set(d.act_dates || []);
  const inWeek = new Set(days.map((x) => x.date));
  const hot = bad.flat().filter((iso) => inWeek.has(iso) && iso >= today && !act.has(iso));
  const without = (...isos) => { const w = new Set(worked); isos.forEach((x) => w.delete(x)); return w; };
  let fixes = hot.filter((iso) => !runsOf(without(iso)).length).map((iso) => ({ kind: 'off', dates: [iso] }));
  if (!fixes.length) {
    for (let i = 0; i < hot.length; i++) {
      for (let j = i + 1; j < hot.length; j++) {
        if (!runsOf(without(hot[i], hot[j])).length) fixes.push({ kind: 'off2', dates: [hot[i], hot[j]] });
      }
    }
  }
  const top = bad.reduce((a, r) => (r.length > a.length ? r : a));
  return { maxRun, runs: bad, hot, fixes,
    breakdown: top.map((iso) => ({ date: iso, done: iso < today || act.has(iso), hot: hot.includes(iso) })) };
}

// The card (2026-10-07): what goes over, the hours behind it, and every fix — as HTML, so the
// Live board's hover card and the Vehicle Assigner's alarm pop-up show exactly the same thing.
// risk = {hours: overRisk(), run: runRisk()}; iso = the day it's shown for; foot = the last line.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mdy = (iso) => parseISODate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const wkd = (iso) => parseISODate(iso).toLocaleDateString('en-US', { weekday: 'long' });
const short = (iso) => mdy(iso).replace(/,.*/, '');
export function riskCardHtml(d, risk, iso, foot = '✓ = already worked. Click a day to change it.') {
  const first = esc(String(d.name).split(/\s+/)[0]);
  const chips = (rows, h) => `<div class="ov-days">${rows.map((x) => `<span class="ov-day${x.hot ? ' hot' : ''}${x.done ? ' done' : ''}">`
    + `${short(x.date)}${h ? ` ${x.h}h` : ''}${x.done ? ' ✓' : ''}</span>`).join('')}</div>`;
  const tail = (r, fixLi, alone) => (r.fixes.length
    ? `<div class="ov-sub">Ways to fix it — any one of these works:</div><ul class="ov-fix">${r.fixes.map(fixLi).join('')}</ul>`
      + (iso && !r.fixes.some((f) => f.dates.includes(iso)) ? `<div class="ov-note">${alone}</div>` : '')
    : r.hot.length ? '<div class="ov-note">No one or two changes fix it — this week needs a bigger rework.</div>'
    : '<div class="ov-note">These days are already worked — nothing left to change this week.</div>');
  const parts = [];
  const h = risk.hours;
  if (h) {
    const fixLi = (f) => {
      const [a, b] = f.dates;
      const t = f.kind === 'off' ? `Take <b>${wkd(a)}</b> off — give that shift to someone else`
        : f.kind === 'backup' ? `Make <b>${wkd(a)}</b> a backup (${h.backupH || 2}h) instead of a route`
        : f.kind === 'short' ? `Send ${first} home after <b>${f.hours}h</b> on <b>${wkd(a)}</b>`
        : `Take <b>${wkd(a)}</b> and <b>${wkd(b)}</b> off`;
      return `<li>${t} <span class="muted">→ most in 7 days ${f.worst}h</span></li>`;
    };
    parts.push(`<div class="ov-card"><div class="ov-title">${esc(d.name)} goes over ${h.max}h in 7 days</div>`
      + h.over.slice(0, 3).map((w) => `<div class="ov-win">${mdy(w.start)} → ${mdy(w.end)}: <b>${w.total}h</b>`
        + ` <span class="ov-by">${Math.round((w.total - h.max) * 100) / 100}h over</span></div>`).join('')
      + '<div class="ov-sub">The worst 7 days, day by day:</div>' + chips(h.breakdown, true)
      + tail(h, fixLi, `Changing ${iso ? wkd(iso) : 'that day'} alone is not enough — use one of the days above.`) + '</div>');
  }
  const r = risk.run;
  if (r) {
    const longest = Math.max(...r.runs.map((x) => x.length));
    const fixLi = (f) => `<li>Take ${f.dates.map((x) => `<b>${wkd(x)}</b>`).join(' and ')} off — give that shift to someone else`
      + ' <span class="muted">(a backup counts as a day worked too)</span></li>';
    parts.push(`<div class="ov-card"><div class="ov-title">${esc(d.name)} would work ${longest} days in a row (max ${r.maxRun})</div>`
      + r.runs.map((x) => `<div class="ov-win">${mdy(x[0])} → ${mdy(x[x.length - 1])}: <b>${x.length} days</b></div>`).join('')
      + chips(r.breakdown, false)
      + tail(r, fixLi, `Taking ${iso ? wkd(iso) : 'that day'} off alone doesn't break the run — use one of the days above.`) + '</div>');
  }
  return parts.join('<hr class="ov-hr">') + (foot ? `<div class="ov-foot">${esc(foot)}</div>` : '');
}

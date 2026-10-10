// The two hard limits a schedule must never break, checked the same way everywhere
// (2026-10-07): over the 7-day hours max, and 6 worked days in any 7 (was: 7 in a row). Used by the Live board and
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
    // days on a route with no out time yet: they worked (Route Tracker, 2026-10-07)
    if ((d.open || []).length) cur.open = [...new Set([...(cur.open || []), ...d.open])];
    // days on a route: {ISO: route code(s) or ""} (Route Tracker, Jose 2026-10-08)
    if (d.routes && Object.keys(d.routes).length) cur.routes = Object.assign(cur.routes || {}, d.routes);
    // backup days {ISO: hours} and route clock-in {ISO: "HH:MM"} (Route Tracker, Jose 2026-10-08)
    if (d.bk && Object.keys(d.bk).length) cur.bk = Object.assign(cur.bk || {}, d.bk);
    if (d.start && Object.keys(d.start).length) cur.start = Object.assign(cur.start || {}, d.start);
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
  const find = actualIndex(list, summary.drivers);
  const ctx = mergeCtx(summary, list, toISODate(new Date()));
  const drivers = (summary.drivers || []).map((d) => {
    const a = find(d);
    if (!a) return d;
    // out on a route with no clock-out yet: open_dates + rt_start, so TODAY's route day still
    // gets the 60h / 6-in-7 checks (overRisk, runRisk) — the Vehicle Assigner too (2026-10-10)
    const o = openOf(a, ctx.dates);
    return { ...mergeOne(d, a, ctx), ...(o.open_dates.length ? o : {}) };
  });
  return { ...summary, drivers };
}
// the week's dates, and the days that are over and that Route Tracker tracked (anyone has a
// clock-out): a driver it knows with no clock-out that day didn't work it — 0 hours, not a
// worked day (2026-10-07)
function mergeCtx(summary, list, today) {
  const dates = (summary.days || []).map((d) => d.date);
  const tracked = new Set();
  for (const a of list) for (const [iso, h] of Object.entries(a.days || {})) if (iso < today && Number(h)) tracked.add(iso);
  const dayOf = Object.fromEntries((summary.days || []).map((x) => [x.date, x.day]));
  return { dates, start: dates[0], tracked, dayOf, lim: summary.limits || {} };
}
// a meeting or Dispatch cell: Route Tracker doesn't track those days (2026-10-10)
const isDuty = (v) => { const s = String(v || '').trim(); return /meeting/i.test(s) || s === 'Dispatch'; };
// one summary driver d with its Route Tracker entry a laid over it (mergeActual, addUnscheduled)
// A meeting / Dispatch day this week with no clock-out isn't zeroed (2026-10-10, the engine's
// _apply_actual does the same): it keeps its scheduled hours (meeting 2h, Dispatch 12h) and is a
// worked day — even when the saved summary was made before this rule and has it at 0.
function mergeOne(d, a, { dates, start, tracked, dayOf = {}, lim = {} }) {
  const duty = {};
  for (const iso of dates) {
    const cell = (d.cells || {})[dayOf[iso]];
    if (isDuty(cell) && !(Number((a.days || {})[iso]) > 0)) duty[iso] = Number((d.day_hours || {})[iso]) || shiftHours(cell, lim);
  }
  const missed = {};
  for (const iso of tracked) if (!Number((a.days || {})[iso]) && !(a.open || []).includes(iso) && !(iso in duty)) missed[iso] = 0;
  const day_hours = { ...(d.day_hours || {}), ...missed, ...a.days, ...duty };
  const clock_hours = Object.entries(day_hours).filter(([k2]) => k2 >= start).reduce((t, [, h]) => t + Number(h || 0), 0);
  let max7 = 0;
  for (const end of dates) {
    let t = 0;
    for (let i = 0; i < 7; i++) t += Number(day_hours[toISODate(addDays(parseISODate(end), -i))] || 0);
    max7 = Math.max(max7, t);
  }
  const act_dates = [...new Set([...Object.keys(a.days).filter((x) => dates.includes(x) && Number(a.days[x])),
    ...Object.keys(missed).filter((x) => dates.includes(x))])].sort();
  // a real shift on an unscheduled day counts as worked (days in a row, days this week);
  // a scheduled day they didn't work doesn't
  const worked = [...new Set([...(d.worked_dates || []), ...Object.keys(a.days).filter((x) => dates.includes(x) && Number(a.days[x])),
    ...Object.keys(duty).filter((x) => duty[x] > 0)])].filter((x) => !(x in missed)).sort();
  let run = 0, best = 0;
  for (const x of dates) { run = worked.includes(x) ? run + 1 : 0; best = Math.max(best, run); }
  // most days worked in any 7 holding a day worked this week (last week's tail from day_hours)
  const all = new Set([...worked, ...Object.keys(day_hours).filter((x) => x < start && Number(day_hours[x]) > 0)]);
  let days7 = 0;
  for (const x of worked) {
    for (let s = -6; s <= 0; s++) {
      let n = 0;
      for (let k = 0; k < 7; k++) if (all.has(toISODate(addDays(parseISODate(x), s + k)))) n++;
      days7 = Math.max(days7, n);
    }
  }
  return { ...d, day_hours, clock_hours: Math.round(clock_hours * 100) / 100, max7: Math.round(max7 * 100) / 100,
    act_dates, worked_dates: worked, streak: Math.max(d.streak || 0, best), max_days7: days7 };
}

// ---- Route Tracker drivers the schedule doesn't have (2026-10-10) ------------------------
// Every driver on a route gets the hours checks (60h in 7 days, 6 days in 7), on the schedule
// or not. A Route Tracker person no schedule driver matches — same test as rtMismatches: their
// Transporter ID or any of their keys belongs to a schedule driver = on the schedule, so a key
// two people share is never guessed — who worked, or has a route or a backup, this week gets a
// stand-in row: {name, tid, notScheduled: true, cells: {}, hours from the real clock-outs (a route
// day with no clock-out yet counts a full route, like withConfirmed), and max7 / streak / days in 7
// counted the same way mergeActual counts them}. Browser view only (Live board, Today page):
// never sent to the rules engine, never saved. Schedule drivers come back untouched.
export function addUnscheduled(summary, list, today = toISODate(new Date())) {
  if (!summary || !(list || []).length || !(summary.days || []).length) return summary;
  const lim = summary.limits || {}, full = lim.primary_hours || 10;
  const ctx = mergeCtx(summary, list, today);
  const find = actualIndex(list, summary.drivers);
  const matched = new Set((summary.drivers || []).map((d) => find(d)).filter(Boolean));
  const clash = schedClash(summary.drivers || []);
  const extra = [];
  for (const a of list) {
    if (matched.has(a) || clash(a)) continue;
    const here = ctx.dates.filter((iso) => Number((a.days || {})[iso]) > 0 || (a.routes && iso in a.routes)
      || (a.open || []).includes(iso) || (a.bk && iso in a.bk));
    if (!here.length) continue;
    const days = { ...(a.days || {}) };
    for (const iso of a.open || []) days[iso] = Math.max(full, Number(days[iso]) || 0);   // like withConfirmed (2026-10-10)
    const base = { name: a.name, tid: tidOf(a), notScheduled: true, cells: {}, day_hours: {}, worked_dates: [], streak: 0,
      cls: null, left: null, helper_days: [] };
    const d = mergeOne(base, { ...a, days }, ctx);
    extra.push({ ...d, hours: d.clock_hours, ...openOf(a, ctx.dates) });
  }
  return extra.length ? { ...summary, drivers: [...(summary.drivers || []), ...extra] } : summary;
}
// {open_dates, rt_start} for a Route Tracker entry, this week's days only
function openOf(a, dates) {
  const open = (a.open || []).filter((iso) => dates.includes(iso)).sort();
  const st = Object.fromEntries(Object.entries(a.start || {}).filter(([iso]) => dates.includes(iso)));
  return { open_dates: open, rt_start: st };
}
// On a route with no clock-out yet (2026-10-10): each schedule driver Route Tracker has out on a
// route gets open_dates (those days) and rt_start ({ISO: "HH:MM"} clock-in). A day like that with
// no hours counts a full route (withConfirmed does the same). overRisk / runRisk then treat TODAY's
// open day as still ahead — the driver is out, the day isn't finished — instead of "already
// worked". Days already over stay as they are. Browser view only, like addUnscheduled.
export function withOpenDays(summary, list) {
  if (!summary || !(list || []).length) return summary;
  const lim = summary.limits || {}, full = lim.primary_hours || 10;
  const dates = (summary.days || []).map((x) => x.date);
  const find = actualIndex(list, (summary.drivers || []).filter((x) => !x.notScheduled));
  const drivers = (summary.drivers || []).map((d) => {
    if (d.notScheduled) return d;              // addUnscheduled already did it
    const a = find(d);
    if (!a) return d;
    const o = openOf(a, dates);
    if (!o.open_dates.length) return d;
    const day_hours = { ...(d.day_hours || {}) };
    for (const iso of o.open_dates) day_hours[iso] = Math.max(full, Number(day_hours[iso]) || 0);   // like withConfirmed (2026-10-10)
    return { ...d, day_hours, worked_dates: [...new Set([...(d.worked_dates || []), ...o.open_dates])].sort(), ...o };
  });
  return { ...summary, drivers };
}
// Out on a route today, no clock-out yet (2026-10-10): what dispatch tells the driver. Same rule as
// the Vehicle Assigner (rtsByRoute) and Route Tracker: whenever today's room (roomOn) is under the
// max day (lim.max_day_hours || 12), the driver gets "RTS & clock out by {by}" — by = clockOutBy from
// Route Tracker's clock-in (30 min before the real limit). over = today puts them over the 7-day max
// (a full route counted); days7 = days worked in 7 holding today when that's more than the usual max.
// texts: "RTS & clock out by 6:35 PM" (or "no hours left today"; "near 60h - no start time, check by
// hand" without a clock-in) and/or "6th day in 7". null = fine.
// Additive fields (2026-10-10): near (room under the max day), room, check (no clock-in to time it).
// More (2026-10-10):
// - cant: today is the 7th day in a row (the 6 days before today all worked — the same "worked"
//   as runRisk: hours that day or on the worked list, last week's tail included). That is also
//   the only way to have more than 6 worked days in the 7 ending today. The owner's rule: a 6th
//   day in 7 is allowed but flagged, a 7th day in a row can't be worked. Then texts is just
//   "can't work today - 7th day in a row" — no RTS time (by null, check false, day12 null).
//   inRow = days in a row up to today (today counted).
// - day12: room for a full max day (lim.max_day_hours || 12) and a Route Tracker clock-in: the
//   12-hour day's own RTS, {limit: clock-in + 12.5h, by: limit - 30, due}. It joins texts as
//   "12-hour day - RTS & clock out by {by}" only once now >= by - 60 min (due); before that the
//   result stays null when nothing else applies. now = ms (or a Date), default Date.now().
// - level (one colour rule for the Live board and the Today page, 2026-10-10): 'warn' (amber) =
//   an RTS time still ahead ("RTS & clock out by …", the 12-hour day's too) and/or the 6th day in
//   7; 'bad' (red) = an RTS time already past (pastDue), over the 7-day max (today's hours
//   counted - the same "over 60h" the red box shows), no hours left today, can't work (7th day in
//   a row), and no clock-in to time it (check). Was: any RTS line 'bad'.
export const HARD_RUN = 7;       // the 7th day in a row can't be worked (2026-10-10)
export function openTodayRisk(d, days, today, lim, now = Date.now()) {
  if (!(d.open_dates || []).includes(today) || !(days || []).some((x) => x.date === today)) return null;
  lim = lim || {};
  const h = overRisk(d, days, today, lim), r = runRisk(d, days, today, lim);
  const over = !!(h && h.hot.includes(today)), six = !!(r && r.hot.includes(today));
  const maxDay = lim.max_day_hours || 12;
  const rm = roomOn(d, today, lim), near = rm.room < maxDay;
  const days7 = six ? Math.max(...r.wins.filter((w) => w.got.includes(today)).map((w) => w.got.length)) : 0;
  // days in a row up to today (today counted): worked = hours that day or on the worked list
  const dh = d.day_hours || {};
  const worked = new Set([...Object.keys(dh).filter((k) => Number(dh[k]) > 0), ...(d.worked_dates || [])]);
  let inRow = 1;
  while (inRow < HARD_RUN && worked.has(toISODate(addDays(parseISODate(today), -inRow)))) inRow++;
  if (inRow >= HARD_RUN) {
    return { date: today, over, six, near, room: rm.room, check: false, days7, by: null, none: false,
      cant: true, inRow, day12: null, level: 'bad', texts: ["can't work today - 7th day in a row"] };
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(String((d.rt_start || {})[today] || ''));
  const clockIn = m ? +m[1] * 60 + +m[2] : null;
  const t = now instanceof Date ? now.getTime() : Number(now);
  const nowMin = (t - parseISODate(today).getTime()) / 60000;
  let day12 = null;
  if (!near && m) {
    const c = clockOutBy(clockIn, maxDay);
    day12 = { by: c.by, limit: c.limit, due: nowMin >= c.by - 60 };
  }
  if (!over && !six && !near && !(day12 && day12.due)) return null;
  let by = null, none = false;
  const check = (over || near) && !m;
  if ((over || near) && m) {
    by = clockOutBy(clockIn, rm.room).by;
    none = rm.room <= 0 || by <= clockIn;
  }
  const hm = (x) => `${((Math.floor(x / 60) + 11) % 12) + 1}:${String(x % 60).padStart(2, '0')} ${x >= 720 ? 'PM' : 'AM'}`;
  const texts = [];
  if (by != null) texts.push(none ? 'no hours left today' : `RTS & clock out by ${hm(by)}`);
  if (check) texts.push('near 60h - no start time, check by hand');
  if (day12 && day12.due) texts.push(`12-hour day - RTS & clock out by ${hm(day12.by)}`);
  if (six) texts.push(`${days7}th day in 7`);
  // past the RTS time (additive, 2026-10-10)
  const pastDue = (by != null && !none && nowMin > by) || !!(day12 && day12.due && nowMin > day12.by);
  const level = over || none || check || pastDue ? 'bad' : 'warn';
  return { date: today, over, six, near, room: rm.room, check, days7, by, none, cant: false, inRow, day12, level, pastDue, texts };
}

// What actual hours each loaded week used (live board compares, and reloads when they change).

// Days already worked (they can't change): the Route Tracker / engine act_dates — except a route
// TODAY with no clock-out yet (withOpenDays / addUnscheduled set open_dates): that driver is still
// out, so today counts as a day ahead (2026-10-10). Without open_dates: act_dates, as before.
// Exported (2026-10-10) for the Live board cell menu's hours left.
export function doneDates(d, today) {
  const act = new Set(d.act_dates || []);
  if ((d.open_dates || []).includes(today)) act.delete(today);
  return act;
}

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
  const act = doneDates(d, today);
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

// 6 worked days in any 7 (Jose 2026-10-07; this used to be "7 days in a row", which it covers):
// the builder locks it; the Live board lets a 6th day through after a pop-up, and those days
// then shake until dispatch fixes it. Worked days =
// any day with hours or on the worked list (last week's tail included). Flags 7-day stretches
// with more than lim.max_days_in_7 (5) worked days that still reach today or later; their
// upcoming days shake. Fixes: a day off that brings every such stretch back to the max (two days
// off if one isn't enough) -- or, keeping the 6 days, ways to stay under the 7-day hours max
// (Jose 2026-10-07): make a route day a backup, or keep every route day ahead under N hours
// (clock-out time per day from its wave; a backup day with a wave counts too, "if sent out" --
// outs[].bk, 2026-10-08). runs = the worked days of each bad stretch. null = fine.
export function runRisk(d, days, today, lim) {
  const maxDays = (lim && lim.max_days_in_7) || 5;
  const dh = d.day_hours || {};
  const sh = (iso, n) => toISODate(addDays(parseISODate(iso), n));
  const first = days[0].date, last = days[days.length - 1].date;
  const starts = [];
  for (let i = -6; sh(first, i) <= last; i++) if (sh(first, i + 6) >= today) starts.push(sh(first, i));
  const badOf = (w) => starts.map((s) => {
    const got = [];
    for (let k = 0; k < 7; k++) if (w.has(sh(s, k))) got.push(sh(s, k));
    return { start: s, end: sh(s, 6), got };
  }).filter((x) => x.got.length > maxDays);
  const worked = new Set([...Object.keys(dh).filter((k) => Number(dh[k]) > 0), ...(d.worked_dates || [])]);
  const bad = badOf(worked);
  if (!bad.length) return null;
  const act = doneDates(d, today);
  const inWeek = new Set(days.map((x) => x.date));
  const hot = [...new Set(bad.flatMap((x) => x.got))].filter((iso) => inWeek.has(iso) && iso >= today && !act.has(iso)).sort();
  const without = (...isos) => { const w = new Set(worked); isos.forEach((x) => w.delete(x)); return w; };
  let fixes = hot.filter((iso) => !badOf(without(iso)).length).map((iso) => ({ kind: 'off', dates: [iso] }));
  if (!fixes.length) {
    for (let i = 0; i < hot.length; i++) {
      for (let j = i + 1; j < hot.length; j++) {
        if (!badOf(without(hot[i], hot[j])).length) fixes.push({ kind: 'off2', dates: [hot[i], hot[j]] });
      }
    }
  }
  // keeping the 6 days: stay under the hours max in every 7-day stretch that still reaches today
  const maxH = (lim && lim.max_7day_hours) || 60, bkH = (lim && lim.backup_hours) || 2;
  const maxDay = (lim && lim.max_day_hours) || 12;
  const r2 = (x) => Math.round(x * 100) / 100;
  const dayOf = (iso) => (days.find((x) => x.date === iso) || {}).day;
  const cellOf = (iso) => String((d.cells || {})[dayOf(iso)] || '');
  const worstH = (h) => Math.max(0, ...starts.map((s) => {
    let t = 0;
    for (let k = 0; k < 7; k++) t += Number(h[sh(s, k)] || 0);
    return r2(t);
  }));
  const drive = hot.filter((iso) => isDrive(cellOf(iso)));
  for (const iso of drive) fixes.push({ kind: 'backup', dates: [iso], worst: worstH({ ...dh, [iso]: bkH }) });
  // the cap counts every day that could turn into a route: route days, and backup days with a
  // wave time ("10:25 AM Backup") in case they're sent out (Jose 2026-10-08) -- each as a full day
  const isBk = (v) => /^\d{1,2}:\d{2} [AP]M/.test(v) && /Backup/.test(v) && !/meeting/i.test(v);
  const sendable = hot.filter((iso) => isDrive(cellOf(iso)) || isBk(cellOf(iso)));
  let hoursOk = false;            // even max-length days stay under the hours max
  if (sendable.length) {
    let cap = Infinity;
    for (const s of starts) {
      let fixed = 0, n = 0;
      for (let k = 0; k < 7; k++) {
        const iso = sh(s, k);
        if (sendable.includes(iso)) n++;
        else fixed += Number(dh[iso] || 0);
      }
      if (n) cap = Math.min(cap, (maxH - fixed) / n);
    }
    cap = Math.floor(cap * 2) / 2;               // whole or half hours, rounded down
    hoursOk = cap >= maxDay;
    if (cap >= 1 && cap < maxDay) {
      const outs = sendable.map((iso) => {
        const bk = isBk(cellOf(iso)) ? { bk: true } : {};
        const m = cellOf(iso).match(/^(\d{1,2}):(\d{2}) ([AP]M)/);
        if (!m) return { date: iso, by: null, ...bk };
        const mins = ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2];
        return { date: iso, by: clockOutBy(mins, cap).by, ...bk };
      });
      fixes.push({ kind: 'cap', dates: sendable, hours: cap, outs, worst: worstH({ ...dh, ...Object.fromEntries(sendable.map((x) => [x, cap])) }) });
    }
  }
  const top = bad.reduce((a, x) => (x.got.length > a.got.length ? x : a));
  const breakdown = [];
  for (let k = 0; k < 7; k++) {
    const iso = sh(top.start, k);
    if (worked.has(iso)) breakdown.push({ date: iso, done: iso < today || act.has(iso), hot: hot.includes(iso) });
  }
  return { maxDays, maxRun: maxDays, maxH, bkH, maxDay, hoursOk, wins: bad, runs: bad.map((x) => x.got), hot, fixes, breakdown };
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
    const hm = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${m >= 720 ? 'PM' : 'AM'}`;
    const off = r.fixes.filter((f) => f.kind === 'off' || f.kind === 'off2');
    const safe = r.fixes.filter((f) => f.kind === 'backup' || f.kind === 'cap');
    const offLi = (f) => `<li>Take ${f.dates.map((x) => `<b>${wkd(x)}</b>`).join(' and ')} off — give that shift to someone else`
      + ' <span class="muted">(a backup counts as a day worked too)</span></li>';
    // backup days are in the cap too, "if sent out" (Jose 2026-10-08)
    const capIntro = (f) => { const nb = f.outs.filter((o) => o.bk).length;
      return !nb ? `Keep every route day to <b>${f.hours}h or less</b>`
        : nb === f.outs.length ? `If ${first} is sent out on a backup day, keep it to <b>${f.hours}h or less</b>`
        : `Keep every route day, and any backup day ${first} is sent out, to <b>${f.hours}h or less</b>`; };
    const safeLi = (f) => (f.kind === 'backup'
      ? `<li>Make <b>${wkd(f.dates[0])}</b> a backup (${r.bkH || 2}h) instead of a route <span class="muted">→ most in 7 days ${f.worst}h</span></li>`
      : `<li>${capIntro(f)} — ${f.outs.map((o) => `${short(o.date).replace(/ .*/, '')}${o.bk && !f.outs.every((x) => x.bk) ? ' <i>(backup, if sent out)</i>' : ''}${o.by != null ? ` clock out by <b>${hm(o.by)}</b>` : ''}`).join(', ')}`
        + ` <span class="muted">→ most in 7 days ${f.worst}h</span></li>`);
    const wins = (r.wins || []).filter((w, i, a) => a.findIndex((v) => v.got.join() === w.got.join()) === i);
    parts.push(`<div class="ov-card"><div class="ov-title">${esc(d.name)} works ${longest} days in 7 (usual max ${r.maxDays})</div>`
      + wins.slice(0, 3).map((w) => `<div class="ov-win">${mdy(w.start)} → ${mdy(w.end)}: <b>${w.got.length} days</b></div>`).join('')
      + '<div class="ov-sub">The worst 7 days — the days worked:</div>' + chips(r.breakdown, false)
      + (!r.hot.length ? '<div class="ov-note">These days are already worked — nothing left to change this week.</div>'
        : (off.length ? `<div class="ov-sub">Back to ${r.maxDays} days — any one of these:</div><ul class="ov-fix">${off.map(offLi).join('')}</ul>` : '')
          + (safe.length ? `<div class="ov-sub">${off.length ? 'Or keep' : 'Keep'} the ${longest} days under ${r.maxH || 60}h in 7 days — any one of these:</div><ul class="ov-fix">${safe.map(safeLi).join('')}</ul>` : '')
          + (r.hoursOk ? `<div class="ov-note">Hours are safe: even ${r.maxDay}-hour days keep ${first} under ${r.maxH || 60}h in 7 days.</div>` : '')
          + (!off.length && !safe.length ? '<div class="ov-note">No one or two changes fix it — this week needs a bigger rework.</div>' : ''))
      + '</div>');
  }
  return parts.join('<hr class="ov-hr">') + (foot ? `<div class="ov-foot">${esc(foot)}</div>` : '');
}

// Room on one day (2026-10-07): the most hours a driver can be on the clock on `iso` and keep
// every 7-day stretch holding that day within the max — the max minus the busiest other 6 days
// of those stretches. `used` = those other days' hours (what the driver "starts the day with").
export function roomOn(d, iso, lim) {
  const max = lim.max_7day_hours || 60, dh = d.day_hours || {};
  const sh = (x, n) => toISODate(addDays(parseISODate(x), n));
  let used = 0;
  for (let s = -6; s <= 0; s++) {
    let t = 0;
    for (let k = 0; k < 7; k++) { const x = sh(iso, s + k); if (x !== iso) t += Number(dh[x] || 0); }
    used = Math.max(used, t);
  }
  used = Math.round(used * 100) / 100;
  return { room: Math.round((max - used) * 100) / 100, used, max };
}

// The latest clock-out that keeps a day within `room` hours, counted the Route Tracker way: on
// the clock from clock-in to clock-out, minus a 30-min lunch once the span is 6h or more.
// Minutes after midnight: {limit} = the real last minute, {by} = `earlyMin` before it.
export function clockOutBy(clockInMin, room, earlyMin = 30) {
  const span = room >= 5.5 ? room + 0.5 : Math.max(0, room);
  const limit = Math.round(clockInMin + span * 60);
  return { limit, by: limit - earlyMin };
}

// ---- "Not in Route Tracker — what happened?" (Jose 2026-10-07) ---------------------------
// A day that's over and that Route Tracker tracked (anyone clocked out), where a driver it knows
// was scheduled to work but has no clock-out and wasn't marked off. Someone answers once —
// called off / no-show / sent home / worked — in the Schedule Builder or Route Tracker
// (Firestore schedule_weeks/{week}/confirm/{date|name}). Until then the day counts 0 hours;
// "worked" counts the scheduled hours until the real clock-out arrives (withConfirmed).
export const ANSWERS = { callout: 'Called off', noshow: 'No-show', senthome: 'Sent home', worked: 'Worked' };
export const confirmKey = (iso, name) => `${iso}|${name}`;
// a schedule cell -> the hours it stands for (0 = not a shift someone works)
// A meeting is 2h (lim.backup_hours) and a day worked (2026-10-10), the same as the engine's
// runner._day_hours (meet -> BH) and _worked_dates — it was 0 here.
function shiftHours(v, lim) {
  const s = String(v || '').trim();
  if (!s || /^(Called out|No-show|Day off|Unavailable)$/.test(s)) return 0;
  if (/meeting/i.test(s)) return lim.backup_hours || 2;
  if (/Backup/.test(s)) return lim.backup_hours || 2;
  if (s === 'Dispatch') return lim.dispatch_hours || 12;
  return /^\d{1,2}:\d{2} [AP]M/.test(s) ? (lim.primary_hours || 10) : 0;
}
// Route Tracker entry for a schedule driver, like runner._matcher: Transporter ID first (exact,
// one entry only), then first|last key; a key two entries share is never guessed. who = a name
// string or a driver {name, tid}; tid may also come as the 2nd argument. (Jose 2026-10-08)
// Same first|last key but DIFFERENT Transporter IDs (both set) = two different people, never
// matched (2026-10-10): the key only picks among entries whose TID is blank or the same, and
// only when exactly one is left — "can't tell" only when the TIDs can't separate them.
const tidOf = (x) => String((x && x.tid) || '').trim();
// two records that both carry a Transporter ID and the IDs differ: not the same person (2026-10-10)
const tidsDiffer = (x, y) => !!(tidOf(x) && tidOf(y) && tidOf(x) !== tidOf(y));
// people (optional, 2026-10-10): the schedule's drivers. A Route Tracker entry that 2+ of them
// would pick (e.g. two schedule drivers share a key, each with their own TID, and the entry has
// no TID) can't be tied to either: it is used for none of them — rtMismatches then lists it as
// 'shared' ("can't tell"). The mirror of two entries vs one driver (never guessed).
function actualIndex(list, people) {
  const raw = actualIndex1(list);
  if (!people) return raw;
  const n = new Map();
  for (const p of people) { const a = raw(p); if (a) n.set(a, (n.get(a) || 0) + 1); }
  return (who, tid) => { const a = raw(who, tid); return a && n.get(a) > 1 ? null : a; };
}
function actualIndex1(list) {
  const by = new Map(), byTid = new Map(), dupTid = new Set();
  for (const a of list || []) {
    const t = tidOf(a);
    if (t) { if (byTid.has(t) && byTid.get(t) !== a) dupTid.add(t); byTid.set(t, a); }
    for (const k of new Set([flKey(a.name), ...(a.keys || [])])) {
      if (!k) continue;
      if (!by.has(k)) by.set(k, []);
      if (!by.get(k).includes(a)) by.get(k).push(a);
    }
  }
  return (who, tid) => {
    const name = who && typeof who === 'object' ? who.name : who;
    const t = String(tid || (who && typeof who === 'object' ? tidOf(who) : '') || '').trim();
    if (t && !dupTid.has(t) && byTid.has(t)) return byTid.get(t);
    const cands = (by.get(flKey(name)) || []).filter((a) => !tidsDiffer(a, { tid: t }));
    return cands.length === 1 ? cands[0] : null;
  };
}
// A Route Tracker entry no schedule driver matched (2026-10-10): true when it can't be told apart
// from one — its Transporter ID is a schedule driver's, or one of its keys is the first|last key of
// a schedule driver whose TID doesn't differ from its own (blank on either side or the same). Then
// it is never guessed: no stand-in, flagged 'shared'. Otherwise it is someone not on the schedule.
function schedClash(drivers) {
  const tids = new Set(drivers.map(tidOf).filter(Boolean));
  return (a) => {
    const keys = new Set([flKey(a.name), ...(a.keys || [])].filter(Boolean));
    return !!(tidOf(a) && tids.has(tidOf(a))) || drivers.some((d) => keys.has(flKey(d.name)) && !tidsDiffer(a, d));
  };
}
// name (or driver {name, tid}) -> {ISO: route code or ""} for every day the driver was on a route (Route Tracker),
// or null. Open days (no out time yet) are route days too. (Jose 2026-10-08)
// people (optional, 2026-10-10): the schedule's drivers; an entry 2+ of them would pick is used for none.
export function routeDays(list, people) {
  const find = actualIndex(list, people);
  return (who, tid) => {
    const a = find(who, tid);
    if (!a) return null;
    const out = { ...(a.routes || {}) };
    for (const iso of a.open || []) if (!(iso in out)) out[iso] = '';
    return Object.keys(out).length ? out : null;
  };
}
// name -> {ISO: hours} for every day the driver was a backup (Route Tracker), or null.
// Same matching as routeDays. (Jose 2026-10-08)
export function backupDays(list, people) {   // people: as routeDays (2026-10-10)
  const find = actualIndex(list, people);
  return (who, tid) => {
    const a = find(who, tid);
    return a && a.bk && Object.keys(a.bk).length ? { ...a.bk } : null;
  };
}

// ---- "Route Tracker and the schedule don't match" (Jose 2026-10-08) ----------------------
// The cloud writer copies Route Tracker's routes / backups onto BLANK schedule days. This lists
// what it won't touch, so a person fixes one side: days up to today where Route Tracker has a
// route or backup and the schedule says something else. Not listed: the two agree, a scheduled
// backup that got a route ("sent out"), a blank day (the writer fills it).
// -> [{name, date, day, cell, rt: 'route'|'backup', kind, why, line, onSchedule, code}]
//    kind: off | mark | train | disp | meet | road | nosched | shared (2026-10-10)
export function rtMismatches(summary, list, today = toISODate(new Date())) {
  if (!summary || !(list || []).length) return [];
  const days = (summary.days || []).filter((x) => x.date <= today);
  const md = (iso) => { const t = parseISODate(iso);
    return `${t.toLocaleDateString('en-US', { weekday: 'short' })} ${t.getMonth() + 1}/${t.getDate()}`; };
  // what Route Tracker has that day: 'route' (wins - they were sent out), 'backup' or null
  const rtOn = (a, iso) => ((a.routes && iso in a.routes) || (a.open || []).includes(iso) ? 'route'
    : a.bk && iso in a.bk ? 'backup' : null);
  const kindOf = (v) => {
    const s = String(v || '').trim();
    if (!s) return 'empty';
    if (s === 'Unavailable') return 'off';
    if (/^(Called out|No-show|Day off)$/.test(s)) return 'mark';
    if (/meeting/i.test(s)) return 'meet';
    if (/TRAIN (helper|drives)/.test(s)) return 'train';
    if (s === 'Dispatch') return 'disp';
    if (/Backup/.test(s)) return 'bk';
    return /^\d{1,2}:\d{2} [AP]M/.test(s) ? 'road' : 'meet';
  };
  const find = actualIndex(list, summary.drivers), out = [];
  // code (additive, 2026-10-10): Route Tracker's route code(s) that day ('' = none / a backup)
  const add = (r, a) => out.push({ ...r, code: r.rt === 'route' ? String((a && a.routes && a.routes[r.date]) || '') : '',
    line: `${r.name} · ${md(r.date)} — ${r.why}` });
  const matched = new Set();
  for (const d of summary.drivers || []) {
    const a = find(d);
    if (!a) continue;
    matched.add(a);
    for (const x of days) {
      const rt = rtOn(a, x.date);
      if (!rt) continue;
      const cell = String((d.cells || {})[x.day] || '').trim(), kind = kindOf(cell);
      const has = rt === 'backup' ? 'has them as a backup' : 'has them on a route';
      let why = null;
      if (kind === 'off') why = `Route Tracker ${has}, but the day is marked Unavailable.`;
      else if (kind === 'mark') why = `Route Tracker ${has}, but the schedule says ${cell}.`;
      else if (kind === 'train' && rt === 'backup') why = 'Route Tracker has a backup on a training day.';
      else if (kind === 'disp' || kind === 'meet') why = `Route Tracker has a ${rt} on a ${kind === 'disp' ? 'Dispatch' : 'meeting'} day.`;
      else if (kind === 'road' && rt === 'backup') why = 'scheduled for a route, Route Tracker has a backup (Amazon had fewer routes?).';
      if (why) add({ name: d.name, date: x.date, day: x.day, cell, rt, kind, why, onSchedule: true }, a);
    }
  }
  // Route Tracker people no schedule driver matches (any of their keys = a schedule name's key)
  // (or a matched entry / a schedule driver's Transporter ID - Jose 2026-10-08)
  const clash = schedClash(summary.drivers || []);
  for (const a of list) {
    if (matched.has(a)) continue;
    // a key or Transporter ID shared with a schedule driver, but no match (two Route Tracker
    // people share it): never guessed, so no stand-in and no hours checks — flag it for a person
    // (kind 'shared', 2026-10-10). Same key but a different Transporter ID than every schedule
    // driver with that key = someone else: 'nosched' below (2026-10-10)
    if (clash(a)) {
      for (const x of days) {
        const rt = rtOn(a, x.date);
        if (rt) add({ name: a.name, date: x.date, day: x.day, cell: '', rt, kind: 'shared',
          why: "can't tell which driver this is - check their hours by hand.", onSchedule: false }, a);
      }
      continue;
    }
    for (const x of days) {
      const rt = rtOn(a, x.date);
      if (rt) add({ name: a.name, date: x.date, day: x.day, cell: '', rt, kind: 'nosched',
        why: "in Route Tracker but not on this week's schedule.", onSchedule: false }, a);
    }
  }
  return out.sort((p, q) => p.date.localeCompare(q.date) || p.name.localeCompare(q.name));
}

// -> [{name, date, day, cell, hours, answer, by, at}] for this week's summary
export function missingDays(summary, list, confirms, today = toISODate(new Date())) {
  if (!summary || !(list || []).length) return [];
  const lim = summary.limits || {};
  const tracked = new Set();
  for (const a of list) for (const [iso, h] of Object.entries(a.days || {})) if (iso < today && Number(h)) tracked.add(iso);
  const find = actualIndex(list, summary.drivers), out = [];
  for (const d of summary.drivers || []) {
    const a = find(d);
    if (!a) continue;                          // Route Tracker doesn't know them: the schedule stands
    for (const x of summary.days || []) {
      if (x.date >= today || !tracked.has(x.date) || Number((a.days || {})[x.date])) continue;
      const cell = String((d.cells || {})[x.day] || '').trim(), hours = shiftHours(cell, lim);
      // Route Tracker doesn't track meetings or Dispatch: nothing to ask (2026-10-10) — the day
      // keeps its scheduled hours (mergeOne, runner._apply_actual)
      if (!hours || isDuty(cell)) continue;
      if ((a.open || []).includes(x.date)) {   // on a route, out time not entered: they worked
        out.push({ name: d.name, tid: tidOf(d), date: x.date, day: x.day, cell, hours, answer: 'worked', auto: true, by: 'Route Tracker' });
        continue;
      }
      const c = (confirms || {})[confirmKey(x.date, d.name)];
      out.push({ name: d.name, tid: tidOf(d), date: x.date, day: x.day, cell, hours, answer: c ? c.answer : null, by: c && c.by, at: c && c.at });
    }
  }
  return out.sort((p, q) => p.date.localeCompare(q.date) || p.name.localeCompare(q.name));
}
// "worked" answers (and route days with no out time yet): the scheduled hours count as that
// day's hours until Route Tracker has the real clock-out — a route day nobody scheduled counts a
// full route. Folded into the driver's own entry so name matching stays the same.
// An open day that already has hours (Route Tracker publishes a still-open day's finished routes,
// 2026-10-10) counts the larger of the two — a long finished route isn't cut down to a flat 10h.
export function withConfirmed(list, missing, lim = {}) {
  const worked = (missing || []).filter((m) => m.answer === 'worked');
  if (!worked.length && !(list || []).some((a) => (a.open || []).length)) return list;
  const find = actualIndex(list);
  const out = (list || []).map((a) => ({ ...a, days: { ...(a.days || {}) } }));
  const byOrig = new Map((list || []).map((a, i) => [a, out[i]]));
  for (const m of worked) {
    const a = find(m);                         // m.tid (missingDays) first, then the name
    if (a && !Number(a.days && a.days[m.date])) byOrig.get(a).days[m.date] = m.hours;
  }
  const full = lim.primary_hours || 10;
  for (const a of out) for (const iso of a.open || []) a.days[iso] = Math.max(full, Number(a.days[iso]) || 0);
  return out;
}

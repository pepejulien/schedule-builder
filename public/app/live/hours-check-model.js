// The Live board's "Hours check" card (Jose 2026-10-23): the rules engine's lines (view.errors) and
// the hours actually worked (Route Tracker clock-outs) boiled down to the few things Jose watches —
// over 12 hours in a day, 6 days out of 7, overtime — plus the hard limits when they happen.
// Fairness / target / backup lines are left out. No app imports, so
// node tests/hours_check_test.mjs can load it.
import { HARD_RUN } from './limits.js';

// "Tue 10/20" / "Sun 09/04" (the engine pads) -> "Tue 10/20" / "Sun 9/4"
const engDate = (s) => String(s || '').replace(/(\w{3}) 0?(\d+)\/0?(\d+)/, '$1 $2/$3');
// "2026-10-20" -> "10/20"
const md = (iso) => { const [, m, d] = String(iso).split('-'); return `${+m}/${+d}`; };
const num = (h) => String(Math.round(Number(h) * 100) / 100);
// a route that day, as cellInfo sees it (kind road or trainee): a wave time, not a backup / trainer /
// meeting. The board passes its own cellInfo test; this copy keeps the model free of app imports.
export const isRouteCell = (v) => {
  const s = String(v || '');
  return /^\d{1,2}:\d{2} [AP]M/.test(s) && !/meeting/i.test(s) && !/TRAIN helper/.test(s) && !/Backup/.test(s);
};

// lines = view.errors; days = view.days; drivers = the board's drivers with Route Tracker merged in
// (withRouteTracker: day_hours, act_dates); gridDrivers = the grid's rows (week hours, cells).
// -> {day12, days6, overtime, over60, dayOff, run7}
export function hoursCheck(lines, { days = [], drivers = [], gridDrivers = drivers, lim = {}, isRoute = isRouteCell } = {}) {
  const maxDay = lim.max_day_hours || 12;
  const label = (iso) => { const x = days.find((y) => y.date === iso); return x ? `${x.day} ${md(iso)}` : md(iso); };
  // "Tue 10/20" from the engine -> that day's ISO date this week (null = not this week)
  const isoOf = (lbl) => { const x = days.find((y) => `${y.day} ${md(y.date)}` === lbl); return x ? x.date : null; };

  const day12 = new Map(), days6 = new Map(), over60 = new Map(), dayOff = new Map(), run7 = new Map(), totdays = new Map();
  const ot = [];
  const putDay12 = (name, h, lbl, iso) => {
    const k = name + '|' + (iso || lbl), old = day12.get(k);
    if (!old || h > old.h) day12.set(k, { name, h, label: lbl, iso });
  };
  const small = [];   // days in a row under HARD_RUN: shown with 6 days out of 7 when nothing else says so
  for (const l of lines || []) {
    let m = l.match(/^HOURS-DAY: (.+?) ([\d.]+)h on (\w{3} [\d/]+)/);
    if (m) { const lbl = engDate(m[3]); putDay12(m[1], Number(m[2]), lbl, isoOf(lbl)); continue; }
    m = l.match(/^HOURS-7DAY: (.+?) ([\d.]+)h in 7 days from (\w{3} [\d/]+)/);
    if (m) { if (!over60.has(m[1])) over60.set(m[1], `${num(m[2])} h in the 7 days from ${engDate(m[3])}`); continue; }
    m = l.match(/^DAYS7>(\d+): (.+?) (\d+) days in 7 from (\w{3} [\d/]+)/);
    if (m) { if (!days6.has(m[2])) days6.set(m[2], `${m[3]} days in the 7 from ${engDate(m[4])}`); continue; }
    m = l.match(/^TOTDAYS: (.+) over (\d+) worked days/);
    if (m) { if (!totdays.has(m[1])) totdays.set(m[1], `${+m[2] + 1} days this week`); continue; }
    m = l.match(/^CONSEC>(\d+): (.+) run=(\d+)/);
    if (m) {
      const n = +m[3];
      if (n >= HARD_RUN) { if (!run7.has(m[2]) || n > run7.get(m[2]).n) run7.set(m[2], { n }); } else small.push([m[2], n]);
      continue;
    }
    m = l.match(/^UNAVAIL violated: (.+) (\w{3})$/);
    if (m) { const a = dayOff.get(m[1]) || []; if (!a.includes(m[2])) a.push(m[2]); dayOff.set(m[1], a); continue; }
    m = l.match(/^OT: (.+) road days over (\d+)h/) || l.match(/^DAYCAP: (.+) over (\d+) primary days/);
    if (m) { if (!ot.includes(m[1])) ot.push(m[1]); continue; }
    // FAIR-SHAPE, TARGET, BACKUP-ONLY, BACKUP<2PRIMARY and anything else: not shown
  }
  for (const [name, t] of totdays) if (!days6.has(name)) days6.set(name, t);
  for (const [name, n] of small) if (!days6.has(name) && !run7.has(name)) days6.set(name, `${n} days in a row`);

  // hours actually worked this week (a real clock-out) over the max day
  for (const d of drivers || []) {
    const act = new Set(d.act_dates || []), dh = d.day_hours || {};
    for (const x of days) {
      const h = Number(dh[x.date]);
      if (act.has(x.date) && h > maxDay) putDay12(d.name, Math.round(h * 100) / 100, label(x.date), x.date);
    }
  }

  const byName = new Map((gridDrivers || []).map((d) => [d.name, d]));
  const overtime = ot.map((name) => {
    const d = byName.get(name);
    if (!d) return { name, routeDays: 0, hours: null };
    const routeDays = days.filter((x) => isRoute((d.cells || {})[x.day])).length;
    const h = d.clock_hours ?? d.hours;
    return { name, routeDays, hours: h == null ? null : Math.round(Number(h) * 100) / 100 };
  }).sort((a, b) => b.routeDays - a.routeDays || a.name.localeCompare(b.name));

  const byWhen = (a, b) => String(a.iso || a.label).localeCompare(String(b.iso || b.label)) || a.name.localeCompare(b.name);
  const people = (m) => [...m].map(([name, detail]) => ({ name, detail })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    day12: [...day12.values()].sort(byWhen),
    days6: people(days6),
    overtime,
    over60: people(over60),
    dayOff: people(new Map([...dayOff].map(([n, a]) => [n, a.join(', ')]))),
    run7: people(new Map([...run7].map(([n, r]) => [n, `${r.n} days in a row`]))),
  };
}

// The card's rows, in order: the three always there, then the hard limits only when they happen.
// -> [{key, title, tone: ok|bad|warn, none?: 'None ✓', lead?: '3 drivers', items: ['Name — ...']}]
export function hoursRows(c) {
  const rows = [];
  const add = (key, title, list, line, { always, noneText = 'None ✓', tone = 'bad', lead } = {}) => {
    if (!list.length) { if (always) rows.push({ key, title, tone: 'ok', none: noneText, items: [] }); return; }
    rows.push({ key, title, tone, ...(lead ? { lead: lead(list) } : {}), items: list.map(line) });
  };
  const who = (p) => `${p.name} — ${p.detail}`;
  add('day12', 'Over 12 hours in a day', c.day12, (p) => `${p.name} — ${num(p.h)} h on ${p.label}`, { always: true });
  add('days6', '6 days out of 7', c.days6, who, { always: true });
  add('overtime', 'Overtime', c.overtime, (p) => (p.hours == null && !p.routeDays ? p.name
    : `${p.name} — ${p.routeDays} route day${p.routeDays === 1 ? '' : 's'}${p.hours == null ? '' : ` · ${num(p.hours)} h`}`),
  { always: true, noneText: 'Nobody ✓', tone: 'warn', lead: (l) => `${l.length} driver${l.length === 1 ? '' : 's'}` });
  add('over60', 'Over 60 hours in 7 days', c.over60, who);
  add('dayOff', 'Working a day they asked off', c.dayOff, who);
  add('run7', '7 days in a row', c.run7, who);
  return rows;
}

// The Live board on a phone (Jose 2026-10-11): one day at a time instead of the week grid.
// Day pills on top, then who works that day by wave (backups, trainers, dispatch, call-outs
// after). A tap on anyone opens the same day menu as a grid cell on a computer.
import { html } from '../preact-setup.js';
import { cellInfo, WAVE_COLORS, SHIFT_COLORS } from './live-model.js';
import { parseISODate } from '../lib/weeks.js';

// "10:05 AM" < "10:25 AM" < "1:05 PM"
const waveMins = (w) => { const m = String(w).match(/(\d{1,2}):(\d{2}) ([AP]M)/); if (!m) return 9999;
  return ((+m[1] % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + +m[2]; };
const waveBg = (w) => WAVE_COLORS[String(w).replace(/ [AP]M$/, '')] || SHIFT_COLORS.other;
const shortDate = (iso) => { const d = parseISODate(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
const byName = (a, b) => a.x.name.localeCompare(b.x.name);
const byWave = (a, b) => waveMins(a.c.top) - waveMins(b.c.top) || byName(a, b);

// the day shown first: today, else the first open day still ahead, else the first open day
export function firstDay(view, today) {
  const t = view.days.find((x) => x.date === today && x.open);
  if (t) return t.day;
  const d = view.days.find((x) => x.open && x.date >= today) || view.days.find((x) => x.open) || view.days[0];
  return d.day;
}

export function DayPills({ view, day, today, onPick }) {
  return html`<div class="lvd-pills" role="tablist" aria-label="Day">
    ${view.days.map((x) => html`<button role="tab" aria-selected=${x.day === day}
      class=${'lvd-pill' + (x.day === day ? ' on' : '') + (x.date === today ? ' today' : '') + (x.open ? '' : ' closed')}
      onClick=${() => onPick(x.day)}>
      <b>${x.day}</b><span>${shortDate(x.date)}</span>
      ${x.open ? html`<small class=${x.routes_filled < x.routes ? 'lv-bad' : ''}>${x.routes_filled}/${x.routes}</small>`
        : html`<small>closed</small>`}</button>`)}
  </div>`;
}

export function DayList({ view, viewRT, day, match, searching, Block, subLine, routeFor, bkFor, markOf, notes, lates, risks,
  ready, busy, onCell, onCounts, onFind, strip }) {
  const dd = view.days.find((x) => x.day === day) || view.days[0];
  const date = parseISODate(dd.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const g = { wave: {}, bk: [], trainer: [], other: [], rt: [], out: [], left: [], off: [], free: [] };
  for (const x of viewRT.drivers) {
    if (!match(x.name)) continue;
    const v = (x.cells || {})[dd.day] || '';
    const c = cellInfo(v);
    const route = routeFor(x.name, dd.date);
    const rtBk = c.kind === 'empty' && route == null ? bkFor(x.name, dd.date) : undefined;
    const lm = x.left ? markOf(x.name, dd.day) : null;
    const left = lm && lm.kind === 'left' && lm.was ? lm.was : null;
    const r = { x, v, c, route, rtBk, left };
    if (x.notScheduled) { if (route != null) g.rt.push(r); continue; }
    if (left) g.left.push(r);
    else if (c.kind === 'road' || c.kind === 'trainee') (g.wave[c.top] = g.wave[c.top] || []).push(r);
    else if (c.kind === 'bk') g.bk.push(r);
    else if (c.kind === 'trainer') g.trainer.push(r);
    else if (c.kind === 'disp' || c.kind === 'meet') g.other.push(r);
    else if (c.kind === 'mark') g.out.push(r);
    else if (c.kind === 'off') g.off.push(r);
    else if (route != null) g.rt.push(r);
    else if (rtBk != null) g.bk.push(r);
    else g.free.push(r);
  }
  const waves = [...new Set([...Object.keys(dd.waves || {}), ...Object.keys(g.wave)])].sort((a, b) => waveMins(a) - waveMins(b));

  const row = (r) => {
    const { x } = r;
    const k = dd.date + '|' + x.name;
    const now = risks[x.name] && risks[x.name].now;
    const hot = risks[x.name] && risks[x.name].hot.includes(dd.date);
    const tap = !x.notScheduled && (dd.open || notes[k]);
    const body = html`
      <div class=${'lvd-blk' + (hot ? ' lv-over' : '')}>${r.c.kind === 'empty' && r.route == null && r.rtBk == null && !r.left
        ? html`<span class="lvd-none">—</span>` : html`<${Block} v=${r.v} route=${r.route} bk=${r.rtBk} left=${r.left} />`}</div>
      <div class="lvd-who">
        <b>${x.name}</b>${notes[k] ? html` <span aria-label="Has a comment">💬</span>` : ''}${lates[k] ? html` <span title=${'Late — ' + lates[k].time} aria-label="Late arrival">⏰</span>` : ''}
        ${r.c.partner ? html`<div class="lv-sub">${r.c.kind === 'trainer' ? 'Training' : 'Trainer'}: ${r.c.partner}</div>` : ''}
        ${subLine(x)}
        ${now && now.texts.length && now.date === dd.date ? html`<div class=${'lv-sub ' + (now.level === 'warn' ? 'lv-warn' : 'lv-bad')}><b>Today: ${now.texts.join(' · ')}</b></div>` : ''}
      </div>`;
    return tap ? html`<button class="lvd-row" onClick=${() => onCell(x.name, dd.day)}>${body}</button>`
      : html`<div class="lvd-row lvd-static">${body}</div>`;
  };
  const section = (key, head, rows, sort, opts = {}) => {
    if (!rows.length && !opts.always) return '';
    const list = html`<div class="lvd-rows">${rows.slice().sort(sort).map(row)}</div>`;
    if (opts.fold && !searching) {
      return html`<details class="lvd-sec lvd-fold" key=${key}><summary class="lvd-head">${head}<span class="lvd-n">${rows.length}</span></summary>${list}</details>`;
    }
    return html`<div class="lvd-sec" key=${key}>
      <div class="lvd-head" style=${opts.bg ? `background:${opts.bg}` : ''}>${head}${opts.right || html`<span class="lvd-n">${rows.length}</span>`}</div>
      ${opts.extra || ''}${list}</div>`;
  };

  if (!dd.open) {
    return html`<div class="lvd">
      <div class="lvd-day"><b>${date}</b> <span class="muted">· closed</span></div>
      ${section('out', 'Called out / No-show', g.out, byName)}
    </div>`;
  }
  const openR = Math.max(0, dd.routes - dd.routes_filled), openB = Math.max(0, dd.backup - dd.backup_filled);
  return html`<div class="lvd">
    <div class="lvd-day">
      <b>${date}</b>
      <button class="lvd-counts" disabled=${!ready || busy} onClick=${() => onCounts(dd.day)}
        title="Routes and backups filled / needed — tap to change the counts">
        <span class=${openR ? 'lv-bad' : ''}>${dd.routes_filled}/${dd.routes} routes</span>
        <span class=${openB ? 'lv-warnc' : ''}> · ${dd.backup_filled}/${dd.backup} backups</span></button>
    </div>
    ${strip || ''}
    ${openR || openB ? html`<div class="lvd-open">
      ${openR ? html`<button class="small" onClick=${() => onFind(dd.day, 'road')}>${openR} route${openR === 1 ? '' : 's'} open — find someone</button>` : ''}
      ${openB ? html`<button class="small" onClick=${() => onFind(dd.day, 'backup')}>${openB} backup${openB === 1 ? '' : 's'} open — find someone</button>` : ''}
    </div>` : ''}
    ${section('left', 'Left the company — shift to cover', g.left, byName)}
    ${waves.map((w) => {
      const rows = g.wave[w] || [];
      const want = (dd.waves || {})[w] || 0;
      if (searching && !rows.length) return '';
      return section('w' + w, html`<b>${w}</b>`, rows, byName, { bg: waveBg(w), always: true,
        right: html`<span class=${'lvd-n' + (rows.length < want ? ' lv-bad' : '')}>${rows.length}${want ? ' of ' + want : ''}</span>` });
    })}
    ${section('bk', html`<b>Backups</b>`, g.bk, byWave, {
      right: html`<span class=${'lvd-n' + (g.bk.length < dd.backup ? ' lv-warnc' : '')}>${g.bk.length}${dd.backup ? ' of ' + dd.backup : ''}</span>` })}
    ${section('tr', html`<b>Trainers</b>`, g.trainer, byName, { bg: SHIFT_COLORS.trainer })}
    ${section('ot', html`<b>Dispatch / Meetings</b>`, g.other, byName)}
    ${section('rt', html`<b>On a route — not on the schedule</b>`, g.rt, byName)}
    ${section('out', html`<b>Called out / No-show</b>`, g.out, byName, { bg: SHIFT_COLORS.mark })}
    ${section('off', html`<b>Unavailable</b>`, g.off, byName, { fold: true })}
    ${section('free', html`<b>Not scheduled</b> <span class="muted">— tap to give a shift</span>`, g.free, byName, { fold: true })}
    ${searching && !Object.values(g).some((v) => (Array.isArray(v) ? v.length : Object.keys(v).length))
      ? html`<p class="muted">Nobody by that name on ${dd.day}.</p>` : ''}
  </div>`;
}

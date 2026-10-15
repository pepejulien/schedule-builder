// Drivers' shift giveaways and trades (Driver App SPEC-v3, PLAN task 36, 2026-10-15): a read-only strip on
// the Live board under the VET / VTO strip. Drivers post, take and trade shifts in the Driver App; once a
// deal is agreed the hub puts it on the board by itself (Jose 2026-10-15: automatic, managers have no
// buttons here). Each row: kind, who gives to whom, the day(s) and shift(s), status, time; open a row for
// the timeline, the giver's exchange days and the trade offers made to the giver. The words come from
// trades-model.js (pure, tested by tests/trades_test.mjs).
import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { Spinner } from '../ui.js';
import { watchTrades, watchTradeProps } from '../api.js';
import {
  dayLabel, timeLabel, kindLabel, whoLabel, shiftLines, tradeStatus, tradeEvents, tradesInScope, swapDaysLabel, propLabel,
} from './trades-model.js';

function useTrades(week) {
  const [rows, setRows] = useState(undefined);
  useEffect(() => {
    setRows(undefined);
    if (!week) return undefined;
    return watchTrades(week, setRows);
  }, [week]);
  return rows;
}

// The strip. week = the shown week's Sunday, weekDates = its 7 dates; date = one picked day (that day's
// trades), else dates = the picked days (null = the whole week). Nothing in scope: no strip.
export function TradesStrip({ week, weekDates, date, dates }) {
  const rows = useTrades(week);
  const [open, setOpen] = useState({});
  if (rows === undefined) return '';
  if (rows === null) return html`<div class="of-strip"><span class="muted">Could not read the drivers' trades.</span></div>`;
  const list = tradesInScope(rows, weekDates, date ? [date] : dates);
  if (!list.length) return '';
  const toggle = (id) => setOpen((s) => ({ ...s, [id]: !s[id] }));
  return html`<div class="of-strip" aria-label="Drivers' trades">
    <div class="of-strip-h">Trades${date ? ` · ${dayLabel(date)}` : ''}
      <span class="muted" style="font-weight:400"> · drivers' giveaways and trades, put on the board automatically</span></div>
    <ul class="of-strip-list">${list.map((t) => html`<${TradeRow} t=${t} key=${t.id}
      expanded=${!!open[t.id]} onToggle=${() => toggle(t.id)} />`)}</ul>
  </div>`;
}

// One trade: kind · who, the shift(s), status chip, when; open -> timeline, exchange days, trade offers.
function TradeRow({ t, expanded, onToggle }) {
  const st = tradeStatus(t);
  return html`<li class="of-strip-row">
    <button class="link of-strip-btn" aria-expanded=${expanded} onClick=${onToggle}>
      <span>${expanded ? '▾' : '▸'} <b>${kindLabel(t)}</b> · ${whoLabel(t)}</span>
      <span>${shiftLines(t).join(' ⇄ ')}</span>
      <span class=${'chip ' + st.chip}>${st.label}</span>
      ${st.reason ? html`<span>${st.reason}</span>` : ''}
      ${st.time ? html`<span class="muted">${timeLabel(st.time)}</span>` : ''}</button>
    ${expanded ? html`<div class="of-indent">
      <div class="muted">${tradeEvents(t).map((e) => `${e.label} ${timeLabel(e.ms)}`).join(' · ')}</div>
      ${swapDaysLabel(t) ? html`<div class="muted">${swapDaysLabel(t)}</div>` : ''}
      <${PropsList} id=${t.id} />
    </div>` : ''}
  </li>`;
}

// The trade offers other drivers made to the giver (watched only while the row is open).
function PropsList({ id }) {
  const [props, setProps] = useState(undefined);
  useEffect(() => watchTradeProps(id, setProps), [id]);
  if (props === undefined) return html`<p class="muted"><${Spinner}/> Loading…</p>`;
  if (props === null) return html`<p class="muted">Could not read the trade offers.</p>`;
  if (!props.length) return '';
  return html`<ul class="of-takes">${props.map((p) => html`<li class="row">
    <span>${propLabel(p)}</span><span class="muted">${timeLabel(p.at)}</span></li>`)}</ul>`;
}

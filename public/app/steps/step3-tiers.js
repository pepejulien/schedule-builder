import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { useStore, setWizard, toast } from '../store.js';
import { StepNav } from '../app.js';
import { Banner, Spinner, TierBadge } from '../ui.js';
import { fetchBoardDb, getStoredBoardPw, setStoredBoardPw } from '../lib/board-fetch.js';
import { computeTiers, validateDb, sanityWarnings, TIER_ORDER } from '../lib/board-metrics.js';
import { matchName } from '../lib/names.js';
import { deriveGroup, groupToValue, hasTierOverlap, GROUP_OPTIONS } from '../lib/config-assemble.js';
import { storeGet, storePutJSON } from '../api.js';

export function Step3Tiers() {
  const avail = useStore((s) => s.wizard.availability);
  const tierByDriver = useStore((s) => s.wizard.tierByDriver);
  const tierMeta = useStore((s) => s.wizard.tierMeta);

  const [pw, setPw] = useState(getStoredBoardPw());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [aliases, setAliases] = useState({});
  const [unmatched, setUnmatched] = useState([]); // board names with no confident roster match

  const roster = avail?.rosterNames || [];

  useEffect(() => {
    storeGet('standing/aliases.json').then((a) => { if (a && typeof a === 'object') setAliases(a); }).catch(() => {});
  }, []);

  function seedRows() {
    // Initialize every roster driver with a default group (not-on-board -> exact 3).
    const rows = { ...tierByDriver };
    for (const name of roster) {
      if (!rows[name]) rows[name] = { tier: 'Unrated', routes: null, rate: null, groupValue: 'exact:3', touched: false, onBoard: false };
    }
    return rows;
  }

  async function doFetch() {
    setBusy(true); setErr('');
    try {
      const db = await fetchBoardDb(pw);
      const probs = validateDb(db);
      if (probs.length) throw Object.assign(new Error('Board data format changed: ' + probs.join('; ')), { code: 'format' });
      setStoredBoardPw(pw);
      const tiers = computeTiers(db, 30);
      const rows = seedRows();
      const newUnmatched = [];
      const usedRoster = new Set();
      for (const t of tiers) {
        const m = matchName(t.name, roster, aliases);
        if (m.match && !usedRoster.has(m.match)) {
          usedRoster.add(m.match);
          const g = deriveGroup(t.tier, t.routes);
          rows[m.match] = {
            tier: t.tier, routes: t.routes, rate: t.rate,
            groupValue: groupToValue(g),
            conflict: hasTierOverlap(t.tier, t.routes),
            touched: false, onBoard: true, boardName: t.name,
          };
        } else {
          newUnmatched.push({ boardName: t.name, tier: t.tier, routes: t.routes, rate: t.rate, chosen: '' });
        }
      }
      setUnmatched(newUnmatched);
      const warnings = sanityWarnings(tiers, db.asof);
      setWizard({ tierByDriver: rows, tierMeta: { asof: db.asof, fetched: true, warnings } });
      toast(`Board loaded — ${tiers.length} drivers (as of ${db.asof})`);
    } catch (e) {
      if (e.code === 'password') setStoredBoardPw('');
      setErr(e.message || 'Could not load the board.');
    } finally {
      setBusy(false);
    }
  }

  function useManual() {
    setWizard({ tierByDriver: seedRows(), tierMeta: { asof: null, fetched: true, warnings: ['Manual tier entry — the board was not loaded.'] } });
  }

  function setRow(name, patch) {
    setWizard((w) => ({ tierByDriver: { ...w.tierByDriver, [name]: { ...w.tierByDriver[name], ...patch, touched: true, conflict: false } } }));
  }

  async function assignUnmatched(idx, rosterName) {
    const list = unmatched.slice();
    const u = list[idx];
    if (rosterName) {
      const g = deriveGroup(u.tier, u.routes);
      setWizard((w) => ({ tierByDriver: { ...w.tierByDriver, [rosterName]: {
        tier: u.tier, routes: u.routes, rate: u.rate, groupValue: groupToValue(g),
        conflict: hasTierOverlap(u.tier, u.routes), touched: false, onBoard: true, boardName: u.boardName } } }));
      // Persist the alias so it auto-applies next week.
      const na = { ...aliases, [u.boardName.replace(/\s+/g, ' ').trim().toLowerCase()]: rosterName };
      setAliases(na);
      storePutJSON('standing/aliases.json', na).catch(() => {});
    }
    list.splice(idx, 1);
    setUnmatched(list);
  }

  const rows = roster.map((name) => ({ name, ...(tierByDriver[name] || {}) }));
  const conflicts = rows.filter((r) => r.conflict);
  const canNext = tierMeta.fetched && conflicts.length === 0;

  return html`
    <div class="card">
      <h2>Step 3 — Driver tiers &amp; names</h2>
      <p class="hint">Pull each driver's tier, 30-day routes and rate straight from the JAJB driver board.
        The board password stays on this device and is never sent anywhere.</p>

      ${!tierMeta.fetched ? html`
        <div class="row">
          <input type="password" placeholder="Board password" value=${pw}
            onInput=${(e) => setPw(e.target.value)} style="min-width:240px" />
          <button class="primary" disabled=${busy || !pw} onClick=${doFetch}>
            ${busy ? html`<${Spinner}/> Loading board…` : 'Fetch tiers from board'}</button>
          <button class="ghost" onClick=${useManual}>Enter tiers manually instead</button>
        </div>
      ` : html`
        <div class="row">
          <button class="small" onClick=${() => { setWizard({ tierMeta: { ...tierMeta, fetched: false } }); }}>Re-fetch board</button>
          ${tierMeta.asof ? html`<span class="muted">Board as of ${tierMeta.asof}</span>` : ''}
        </div>`}

      ${err ? html`<${Banner} kind="err">${err}<//>` : ''}
      ${(tierMeta.warnings || []).map((wn) => html`<${Banner} kind="warn">${wn}<//>`)}

      ${unmatched.length ? html`
        <h3>Board drivers not matched to the roster</h3>
        <p class="hint">Pick the matching roster name, or leave blank to skip (departed / not on this week's sheet).</p>
        <div class="scroll-x"><table>
          <thead><tr><th>Board name</th><th>Tier</th><th>Routes</th><th>Assign to roster driver</th></tr></thead>
          <tbody>${unmatched.map((u, i) => html`
            <tr>
              <td>${u.boardName}</td>
              <td><${TierBadge} tier=${u.tier}/></td>
              <td>${u.routes ?? '—'}</td>
              <td><select value=${u.chosen} onChange=${(e) => assignUnmatched(i, e.target.value)}>
                <option value="">— skip —</option>
                ${roster.map((rn) => html`<option value=${rn}>${rn}</option>`)}
              </select></td>
            </tr>`)}</tbody>
        </table></div>` : ''}

      ${tierMeta.fetched ? html`
        <h3>Day-target per driver</h3>
        ${conflicts.length ? html`<${Banner} kind="err">
          ${conflicts.length} driver(s) match two day-count rules (e.g. Top performer <b>and</b> under 5 routes).
          Choose a day-target for each highlighted row before continuing.<//>` : ''}
        <div class="scroll-x"><table>
          <thead><tr><th>Driver</th><th>Tier</th><th>Routes (30d)</th><th>Rate</th><th>Day target</th></tr></thead>
          <tbody>${rows.map((r) => html`
            <tr class=${r.conflict ? 'rowbad' : ''}>
              <td>${r.name}${r.onBoard === false ? html` <span class="chip gray">not on board</span>` : ''}</td>
              <td>
                <select value=${r.tier} onChange=${(e) => setRow(r.name, { tier: e.target.value })}>
                  ${TIER_ORDER.map((t) => html`<option value=${t}>${t}</option>`)}
                </select>
              </td>
              <td><input type="text" inputmode="numeric" value=${r.routes ?? ''} style="width:70px"
                onInput=${(e) => setRow(r.name, { routes: e.target.value === '' ? null : Number(e.target.value) })} /></td>
              <td><input type="text" value=${r.rate ?? ''} style="width:70px"
                onInput=${(e) => setRow(r.name, { rate: e.target.value === '' ? null : Number(e.target.value) })} /></td>
              <td><select value=${r.groupValue} onChange=${(e) => setRow(r.name, { groupValue: e.target.value })}>
                ${GROUP_OPTIONS.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
              </select></td>
            </tr>`)}</tbody>
        </table></div>
      ` : ''}

      <${StepNav} canNext=${canNext} />
    </div>`;
}

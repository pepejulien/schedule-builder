// Minimal reactive store for the wizard — no framework beyond Preact hooks.
import { useState, useEffect } from 'preact/hooks';
import { nextSunday, toISODate } from './lib/weeks.js';
import { saveDraft, clearDraft } from './draft.js';

function freshWizard() {
  return {
    step: 0,                       // 0..8 wizard steps
    week: { num: '', startISO: toISODate(nextSunday()), label: '' },
    availability: null,            // { fileName, bytes(ArrayBuffer), drivers, counts, rosterNames }
    tierByDriver: {},              // rosterName -> { tier, routes, rate, groupValue, conflict }
    tierMeta: { asof: null, fetched: false, warnings: [] },
    priorWeek: { bytes: null, source: null }, // source: 'blobs'|'upload'|'none'
    demand: {},                    // day -> [{ portalTime, count }]
    demandConfirmedClosed: {},     // day -> bool (explicit closed confirmation)
    backups: { mode: 'pct', pct: 0.15, perDay: {} },
    standing: null,                // loaded from Blobs: { exclude, bench, dispatch, trainers, trainingPairs, hasPrefs }
    advanced: {},                  // config overrides
    build: { status: 'idle', report: null, xlsx: null, error: null, savedName: null },
  };
}

let state = {
  auth: 'unknown',                 // 'unknown' | 'in' | 'out'
  route: 'home',                   // 'home' | 'wizard' | 'settings'
  wizard: freshWizard(),
  toast: null,
};

const subs = new Set();

export function getState() { return state; }

export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  subs.forEach((f) => f(state));
}

// Debounced auto-save of the in-progress wizard to IndexedDB.
let draftTimer = null;
function scheduleDraftSave() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveDraft(state.wizard), 600);
}

// Update wizard sub-state conveniently.
export function setWizard(patch) {
  const w = state.wizard;
  const nextW = { ...w, ...(typeof patch === 'function' ? patch(w) : patch) };
  setState({ wizard: nextW });
  scheduleDraftSave();
}

// Restore a saved draft (merged onto a fresh wizard so new fields exist).
export function hydrateWizard(wizard) {
  setState({ wizard: { ...freshWizard(), ...wizard } });
}

// Continue the current draft.
export function continueWizard() {
  setState({ route: 'wizard' });
}

// Start a brand-new schedule, discarding any saved draft.
export async function startFresh() {
  await clearDraft();
  setState({ wizard: freshWizard(), route: 'wizard' });
}

export function useStore(selector = (s) => s) {
  const [v, setV] = useState(() => selector(state));
  useEffect(() => {
    const f = (s) => setV(() => selector(s));
    subs.add(f);
    f(state);
    return () => subs.delete(f);
  }, []);
  return v;
}

let toastTimer = null;
export function toast(message, kind = 'ok') {
  setState({ toast: { message, kind } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), 4000);
}

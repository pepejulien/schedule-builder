// The Live board's Route Tracker alert cards above the Hours check, with the owner's and HR's Hide
// button (2026-11-25): "Worked, but the out time is missing" (missing.js) and "Route Tracker and the
// schedule don't match" (rt-check.js). Hidden on this login's screen only; a new row brings a card
// back (alert-hide.js). Everyone else sees the cards as before.
import { html } from '../preact-setup.js';
import { useState, useEffect } from 'preact/hooks';
import { canHideAlerts, myUid } from '../api.js';
import { MissingCheck } from './missing.js';
import { RtCheck } from './rt-check.js';
import { workedKeys, rtKeys, pruneHidden, loadHidden, saveHidden } from './alert-hide.js';

// loaded: Route Tracker's hours are in — until then a hidden card stays hidden, nothing is re-checked
export function AlertCards({ week, missing, rows, onOpen, loaded }) {
  const can = canHideAlerts(), uid = can ? myUid() : '';
  const [hid, setHid] = useState(() => loadHidden(uid, week));
  useEffect(() => setHid(loadHidden(uid, week)), [uid, week]);
  const keys = { worked: workedKeys(missing), rt: rtKeys(rows) };
  const sig = keys.worked.join('\n') + '\n\n' + keys.rt.join('\n');
  // a new row in a hidden card: show it again and forget it was hidden
  useEffect(() => {
    if (!uid || !loaded) return;
    const left = pruneHidden(hid, keys);
    if (Object.keys(left).length !== Object.keys(hid).length) { setHid(left); saveHidden(uid, week, left); }
  }, [uid, week, loaded, sig, hid]);
  const set = (next) => { setHid(next); saveHidden(uid, week, next); };
  const hide = (card) => (uid ? () => set({ ...hid, [card]: keys[card] }) : null);
  const n = ['worked', 'rt'].filter((c) => hid[c] && keys[c].length).length;
  return html`
    <${MissingCheck} week=${week} missing=${missing} hideWorked=${!!(uid && hid.worked)} onHide=${hide('worked')} />
    ${uid && hid.rt ? '' : html`<${RtCheck} rows=${rows} onOpen=${onOpen} onHide=${hide('rt')} />`}
    ${uid && n ? html`<button class="link ms-showhidden" onClick=${() => set({})}>Show hidden (${n})</button>` : ''}`;
}

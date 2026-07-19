// Fetch + decrypt the JAJB driver board's data, entirely in the browser.
// The board publishes an encrypted blob in cell A1 of a public Google Sheet;
// we fetch the same CSV endpoint (CORS-open) and decrypt with the board
// password using the same PBKDF2 -> AES-GCM scheme the board itself uses.
//
// The board password never leaves the browser (localStorage only) — same as
// the board's own UX. It is NEVER sent to our Netlify functions.

const SHEET_ID = '1D82YJD-9fkUQR2tCHx9wYXGDsxvrjhfSUIyzKT1WDdo';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`
  + '/gviz/tq?tqx=out:csv&range=A1&headers=0';
const SALT = 'jajb-board-v1';
const PW_STORE = 'sb_board_pw';

export function getStoredBoardPw() {
  try { return localStorage.getItem(PW_STORE) || ''; } catch { return ''; }
}
export function setStoredBoardPw(pw) {
  try { if (pw) localStorage.setItem(PW_STORE, pw); else localStorage.removeItem(PW_STORE); } catch { /* ignore */ }
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

async function deriveKey(pw) {
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(SALT), iterations: 200000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
}

async function maybeGunzip(u) {
  if (u[0] === 0x1f && u[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('gzip unsupported in this browser');
    const ds = new DecompressionStream('gzip');
    return await new Response(new Blob([u]).stream().pipeThrough(ds)).text();
  }
  return new TextDecoder('utf-8').decode(u);
}

// Decode the A1 payload. Format mirrors the board's _decode():
//   "enc1:<base64>"  -> AES-GCM(iv=first 12 bytes, ct=rest) -> maybe gzip -> JSON
//   "<base64>"       -> maybe gzip -> JSON  (unencrypted fallback)
async function decodePayload(payload, key) {
  let bytes;
  if (typeof payload === 'string' && payload.indexOf('enc1:') === 0) {
    if (!key) throw new Error('locked');
    const raw = b64ToBytes(payload.slice(5));
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12),
    );
    bytes = new Uint8Array(pt);
  } else {
    bytes = b64ToBytes(payload);
  }
  const txt = await maybeGunzip(bytes);
  return JSON.parse(txt);
}

// Fetch and decrypt. Throws:
//   'network'  — the sheet endpoint is unreachable / non-200
//   'password' — decrypt failed (wrong board password)
//   'format'   — decrypted but not the expected JSON shape
export async function fetchBoardDb(pw) {
  if (!(window.crypto && crypto.subtle)) {
    const e = new Error('This app needs a secure (https) connection to read the board.');
    e.code = 'network';
    throw e;
  }
  let txt;
  try {
    const res = await fetch(SHEET_CSV_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('sheet HTTP ' + res.status);
    txt = (await res.text()).trim();
  } catch (err) {
    const e = new Error('Could not reach the driver board sheet. Check your connection.');
    e.code = 'network';
    e.cause = err;
    throw e;
  }
  // gviz wraps a single cell in quotes and doubles internal quotes.
  if (txt.charAt(0) === '"' && txt.charAt(txt.length - 1) === '"') {
    txt = txt.slice(1, -1).replace(/""/g, '"');
  }
  const needsKey = txt.indexOf('enc1:') === 0;
  const key = needsKey ? await deriveKey(pw) : null;
  try {
    const db = await decodePayload(txt, key);
    if (!db || !Array.isArray(db.drivers)) {
      const e = new Error('The board data was read but is not in the expected format.');
      e.code = 'format';
      throw e;
    }
    return db;
  } catch (err) {
    if (err.code === 'format') throw err;
    // AES-GCM decrypt throws OperationError on a wrong key/password.
    const e = new Error('The board password looks wrong — re-enter it and try again.');
    e.code = 'password';
    e.cause = err;
    throw e;
  }
}

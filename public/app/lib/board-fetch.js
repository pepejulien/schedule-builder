// Fetch + decrypt the JAJB driver board's data, entirely in the browser.
// The board publishes an encrypted blob down column A of a public Google Sheet;
// we fetch the same CSV endpoint (CORS-open) and decrypt with the board
// password using the same PBKDF2 -> AES-GCM scheme the board itself uses.
//
// The board password never leaves the browser (localStorage only) — same as
// the board's own UX. It is NEVER sent to our Netlify functions.

const SHEET_ID = '1D82YJD-9fkUQR2tCHx9wYXGDsxvrjhfSUIyzKT1WDdo';
// A Sheets cell caps at 50k characters, so the board splits the blob into 45k
// chunks: A1 + A2 + ... Reading A1 alone yields a truncated payload whose
// AES-GCM tag then fails — which looks exactly like a wrong password.
const MAX_CHUNKS = 20;
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`
  + `/gviz/tq?tqx=out:csv&range=A1:A${MAX_CHUNKS}&headers=0`;
const SALT = 'jajb-board-v1';
const PW_STORE = 'sb_board_pw';

export function getStoredBoardPw() {
  try { return localStorage.getItem(PW_STORE) || ''; } catch { return ''; }
}
export function setStoredBoardPw(pw) {
  try { if (pw) localStorage.setItem(PW_STORE, pw); else localStorage.removeItem(PW_STORE); } catch { /* ignore */ }
}

// gviz returns one CSV line per cell, each wrapped in quotes with internal
// quotes doubled. Stitch column A back into the single payload string.
export function joinChunks(csv) {
  const chunks = [];
  for (const line of String(csv).split(/\r?\n/)) {
    let s = line.trim();
    if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
      s = s.slice(1, -1).replace(/""/g, '"');
    }
    if (s) chunks.push(s);
  }
  return { payload: chunks.join(''), count: chunks.length };
}

function b64ToBytes(b64) {
  // atob's forgiving decode silently accepts a truncated string and returns
  // garbage, so check the length ourselves.
  if (b64.length % 4 !== 0) {
    const e = new Error('The board data came back incomplete (truncated mid-payload).');
    e.code = 'format';
    throw e;
  }
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
  let raw;
  try {
    const res = await fetch(SHEET_CSV_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('sheet HTTP ' + res.status);
    raw = (await res.text()).trim();
  } catch (err) {
    const e = new Error('Could not reach the driver board sheet. Check your connection.');
    e.code = 'network';
    e.cause = err;
    throw e;
  }
  const { payload: txt, count } = joinChunks(raw);
  if (count >= MAX_CHUNKS) {
    const e = new Error(`The board now publishes more than ${MAX_CHUNKS} chunks — this app is reading only the first ${MAX_CHUNKS}.`);
    e.code = 'format';
    throw e;
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
    // Only a failed AES-GCM tag check means the key — and so the password —
    // was wrong. Anything else (gzip, JSON) is a data problem, not the password.
    if (err.name === 'OperationError' || err.message === 'locked') {
      const e = new Error('The board password looks wrong — re-enter it and try again.');
      e.code = 'password';
      e.cause = err;
      throw e;
    }
    const e = new Error('The board data could not be decoded: ' + (err.message || err));
    e.code = 'format';
    e.cause = err;
    throw e;
  }
}

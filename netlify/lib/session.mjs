// Shared session-cookie helpers (HMAC-signed expiry). Lives outside the
// functions directory so it isn't published as its own endpoint.
import crypto from 'node:crypto';

const COOKIE = 'sb_session';
const MAX_AGE = 30 * 24 * 3600; // 30 days

function secret() { return process.env.AUTH_SECRET || ''; }

export function sign(expMs) {
  const payload = String(expMs);
  const mac = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

export function verify(token) {
  if (!token || !secret()) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const exp = parseInt(payload, 10);
  return Number.isFinite(exp) && Date.now() < exp;
}

export function makeCookie() {
  const token = sign(Date.now() + MAX_AGE * 1000);
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function tokenFromReq(req) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(/(?:^|;\s*)sb_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export function requireAuth(req) {
  return verify(tokenFromReq(req));
}

// Constant-time password check via fixed-length digests.
export function passwordMatches(supplied) {
  const expected = process.env.APP_PASSWORD || '';
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(supplied || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

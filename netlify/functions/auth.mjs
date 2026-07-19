// POST /api/auth  {password}  -> 204 + session cookie, or 401
// GET  /api/auth              -> 204 if signed in, else 401
// DELETE /api/auth            -> 204, clears the cookie
import { requireAuth, makeCookie, clearCookie, passwordMatches } from '../lib/session.mjs';

export default async (req) => {
  const method = req.method;

  if (method === 'GET') {
    return requireAuth(req)
      ? new Response(null, { status: 204 })
      : new Response(null, { status: 401 });
  }

  if (method === 'DELETE') {
    return new Response(null, { status: 204, headers: { 'set-cookie': clearCookie() } });
  }

  if (method === 'POST') {
    if (!process.env.APP_PASSWORD) {
      return new Response('APP_PASSWORD is not configured on the server.', { status: 500 });
    }
    let body = {};
    try { body = await req.json(); } catch { /* empty */ }
    if (passwordMatches(body.password)) {
      return new Response(null, { status: 204, headers: { 'set-cookie': makeCookie() } });
    }
    return new Response(null, { status: 401 });
  }

  return new Response('Method not allowed', { status: 405 });
};

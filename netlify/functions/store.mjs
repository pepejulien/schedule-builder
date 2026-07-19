// Authenticated key-value proxy over Netlify Blobs. Stores only app SETTINGS
// (standing config, name aliases, the optional preferences CSV) — never the
// built schedules themselves. The schedules live in the user's own files.
//   GET  /api/store?key=<key>       -> content (json / csv)
//   PUT  /api/store?key=<key>       -> 204 (body = json / text)
import { getStore } from '@netlify/blobs';
import { requireAuth } from '../lib/session.mjs';

const KEY_RE = /^standing\/(config\.json|prefs\.csv|aliases\.json)$/;

function contentTypeFor(key) {
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.csv')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function store() {
  return getStore({ name: 'schedule-builder', consistency: 'strong' });
}

export default async (req) => {
  if (!requireAuth(req)) return new Response('Unauthorized', { status: 401 });

  const url = new URL(req.url);
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('Bad key', { status: 400 });

  if (req.method === 'GET') {
    const txt = await store().get(key, { type: 'text' }).catch(() => null);
    if (txt == null) return new Response('Not found', { status: 404 });
    return new Response(txt, { status: 200, headers: { 'content-type': contentTypeFor(key) } });
  }

  if (req.method === 'PUT') {
    const txt = await req.text();
    await store().set(key, txt);
    return new Response(null, { status: 204 });
  }

  return new Response('Method not allowed', { status: 405 });
};

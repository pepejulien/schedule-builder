// Fetch client for the Netlify Functions (/api/*). Cookies carry the session.

async function req(path, opts = {}) {
  const res = await fetch('/api/' + path, { credentials: 'same-origin', ...opts });
  return res;
}

export async function checkAuth() {
  try {
    const res = await req('auth');
    return res.status === 204;
  } catch { return false; }
}

export async function login(password) {
  const res = await req('auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return res.status === 204;
}

export async function logout() {
  await req('auth', { method: 'DELETE' });
}

// --- Blobs store ---
export async function storeGet(key) {
  const res = await req('store?key=' + encodeURIComponent(key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('store get failed: ' + res.status);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.arrayBuffer();
}

export async function storePutJSON(key, obj) {
  const res = await req('store?key=' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (!res.ok) throw new Error('store put failed: ' + res.status);
}

export async function storeText(key, text) {
  const res = await req('store?key=' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: text,
  });
  if (!res.ok) throw new Error('store put failed: ' + res.status);
}

// --- Screenshot parse ---
export async function parseScreenshot(base64, mediaType) {
  const res = await req('parse-screenshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image_base64: base64, media_type: mediaType }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    const e = new Error(msg || 'Screenshot parsing is unavailable — enter the counts manually.');
    e.status = res.status;
    throw e;
  }
  return res.json();
}

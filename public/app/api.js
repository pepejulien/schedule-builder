// Backend client. The app runs in two places while it moves (2026-10-03):
//   * jajb-ops.web.app/schedule/ (Firebase) — window.JAJB is the shared JAJB
//     sign-in bundle (build_site.py injects it). One login for every JAJB app;
//     settings live in Firestore schedule/*, training records in
//     schedule_training/{weekStart} (shaped so other JAJB apps can read them later).
//   * the old Netlify site — shared password + Netlify Functions (/api/*).
// Every caller uses the same functions below and never needs to know which.

export const onFirebase = () => typeof window !== 'undefined' && !!window.JAJB;

// ---------------------------------------------------------------- Netlify --
async function req(path, opts = {}) {
  return fetch('/api/' + path, { credentials: 'same-origin', ...opts });
}

// ------------------------------------------------------------------- auth --
// Firebase: true once signed in with the Schedule Builder on this login; a
// signed-out visitor is sent to the hub's sign-in and comes back here.
// Returns true | false | 'no-app'.
export async function checkAuth() {
  if (onFirebase()) {
    await window.JAJB.ready;
    if (!window.JAJB.user()) {
      location.replace('/?next=' + encodeURIComponent(location.pathname));
      return new Promise(() => {});            // navigating away
    }
    await window.JAJB.waitMe();
    return window.JAJB.has('schedule') ? true : 'no-app';
  }
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
  if (onFirebase()) {
    await window.JAJB.signOut();
    location.href = '/';
    return;
  }
  await req('auth', { method: 'DELETE' });
}

// Who is signed in (Firebase only) — shown in the sidebar.
export function whoAmI() {
  if (!onFirebase()) return null;
  const me = window.JAJB.me();
  return me ? (me.name || window.JAJB.user()?.email || '') : null;
}

// ----------------------------------------------------------------- settings --
// The keys the app has always used, and where each lives in Firestore.
const FB_DOCS = {
  'standing/config.json': ['standing', 'json'],
  'standing/aliases.json': ['aliases', 'json'],
  'standing/prefs.csv': ['prefs', 'text'],
};

export async function storeGet(key) {
  if (onFirebase()) {
    if (key === 'standing/training-history.json') return loadTrainingHistory();
    const [name, field] = FB_DOCS[key] || [];
    if (!name) throw new Error('unknown setting: ' + key);
    const d = await window.JAJB.scheduleGet(name);
    if (!d || d[field] == null) return null;
    return field === 'json' ? JSON.parse(d.json) : d.text;
  }
  const res = await req('store?key=' + encodeURIComponent(key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('store get failed: ' + res.status);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.arrayBuffer();
}

export async function storePutJSON(key, obj) {
  if (onFirebase()) {
    const [name, field] = FB_DOCS[key] || [];
    if (field !== 'json') throw new Error('unknown setting: ' + key);
    return window.JAJB.schedulePut(name, { json: JSON.stringify(obj) });
  }
  const res = await req('store?key=' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (!res.ok) throw new Error('store put failed: ' + res.status);
}

export async function storeText(key, text) {
  if (onFirebase()) {
    const [name, field] = FB_DOCS[key] || [];
    if (field !== 'text') throw new Error('unknown setting: ' + key);
    return window.JAJB.schedulePut(name, { text: String(text) });
  }
  const res = await req('store?key=' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: text,
  });
  if (!res.ok) throw new Error('store put failed: ' + res.status);
}

// ------------------------------------------------------- training records --
// One record per week: {week (start Sunday ISO), label, pairs: [{trainer,
// trainee, day, date, wave, picked: 'auto'|'chosen'}]}. A rebuild of the same
// week replaces its record. The trainer rotation reads them back as
// {weekISO: [[trainer, trainee, day], ...]}.
export async function loadTrainingHistory() {
  if (onFirebase()) {
    const out = {};
    for (const r of await window.JAJB.scheduleTraining()) {
      out[r.week] = (r.pairs || []).map((p) => [p.trainer, p.trainee, p.day]);
    }
    return out;
  }
  const res = await req('store?key=' + encodeURIComponent('standing/training-history.json'));
  if (!res.ok) return {};
  return res.json();
}

export async function saveTrainingWeek(weekISO, label, pairs) {
  if (!weekISO) return null;
  if (onFirebase()) {
    await window.JAJB.saveScheduleTraining(weekISO, label || '', pairs);
    return loadTrainingHistory();
  }
  let h = {};
  try { h = await loadTrainingHistory(); } catch { /* start fresh */ }
  h[weekISO] = pairs.map((p) => [p.trainer, p.trainee, p.day]);
  const keep = Object.keys(h).sort().slice(-26);           // ~6 months is plenty
  const out = {};
  for (const k of keep) out[k] = h[k];
  await storePutJSON('standing/training-history.json', out);
  return out;
}

// -------------------------------------------------- settings export/import --
// Moving from Netlify to Firebase: download everything on the old site, load
// it on the new one. Same file both ways.
export async function exportSettings() {
  const get = async (k) => { try { return await storeGet(k); } catch { return null; } };
  let prefs = await get('standing/prefs.csv');
  if (prefs && typeof prefs !== 'string') prefs = new TextDecoder('utf-8').decode(new Uint8Array(prefs));
  return {
    kind: 'jajb-schedule-settings', version: 1, exported: new Date().toISOString(),
    standing: await get('standing/config.json'),
    aliases: await get('standing/aliases.json'),
    prefs: prefs || null,
    trainingHistory: await loadTrainingHistory().catch(() => ({})),
  };
}

export async function importSettings(data) {
  if (!data || data.kind !== 'jajb-schedule-settings') throw new Error("That isn't a Schedule Builder settings file.");
  const done = [];
  if (data.standing) { await storePutJSON('standing/config.json', data.standing); done.push('standing settings'); }
  if (data.aliases) { await storePutJSON('standing/aliases.json', data.aliases); done.push('name matches'); }
  if (data.prefs) { await storeText('standing/prefs.csv', data.prefs); done.push('driver preferences'); }
  const weeks = Object.entries(data.trainingHistory || {});
  for (const [wk, rows] of weeks) {
    await saveTrainingWeek(wk, '', (rows || []).map((r) => ({ trainer: r[0], trainee: r[1], day: r[2] })));
  }
  if (weeks.length) done.push(`${weeks.length} week(s) of training history`);
  return done;
}

// -------------------------------------------------------- screenshot parse --
// Netlify Function only (it holds the Anthropic key). Not on Firebase yet.
export const canParseScreenshot = () => !onFirebase();

export async function parseScreenshot(base64, mediaType) {
  if (onFirebase()) throw new Error('Reading a screenshot isn\'t on the new site yet — type the counts, or pre-fill from last week.');
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

// ------------------------------------------------------------- live board --
// Published weeks the team works on midweek (Firebase only — Netlify has no
// shared database). Firestore schedule_weeks/{weekStart}: see jajb.js.
export const canLive = () => onFirebase() && typeof window.JAJB.saveScheduleWeek === 'function';
export const liveWeeks = (n) => window.JAJB.scheduleWeeks(n);
export const liveWeek = (weekISO) => window.JAJB.scheduleWeekData(weekISO);
export const watchLiveWeek = (weekISO, cb) => window.JAJB.watchScheduleWeek(weekISO, cb);
export const watchLiveLog = (weekISO, cb) => window.JAJB.watchScheduleLog(weekISO, cb);
export const saveLiveWeek = (weekISO, w) => window.JAJB.saveScheduleWeek(weekISO, w);
export const deleteLiveWeek = (weekISO) => window.JAJB.deleteScheduleWeek(weekISO);
// comments on shifts (2026-10-07): {"<ISO day>|<name>": {name, day, text, by, at}}
export const watchLiveNotes = (weekISO, cb) => (window.JAJB.watchScheduleNotes
  ? window.JAJB.watchScheduleNotes(weekISO, cb) : (cb({}), () => {}));
export const saveLiveNote = (weekISO, name, day, text) => window.JAJB.saveScheduleNote(weekISO, name, day, text);

// Actual hours from Route Tracker's clock-outs (2026-10-07): Firestore actual_hours/{weekStart}
// = {week, drivers: {id: {name, keys, tid, days: {ISO: hours}}}, by, at}. Written by Route Tracker
// a few seconds after each clock-out; read here so days already worked count their real hours.
const canActual = () => onFirebase() && typeof window.JAJB.watch === 'function';
export const watchActualHours = (weekISO, cb) => (canActual() ? window.JAJB.watch('actual_hours/' + weekISO, cb) : () => {});
export function actualHoursOnce(weekISO, ms = 6000) {
  if (!canActual()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false, un = null;
    const finish = (d) => { if (done) return; done = true; clearTimeout(t); setTimeout(() => un && un(), 0); resolve(d); };
    const t = setTimeout(() => finish(null), ms);   // no signal: plan with what we have
    un = window.JAJB.watch('actual_hours/' + weekISO, finish);
  });
}

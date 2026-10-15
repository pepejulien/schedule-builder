// A stand-in for the JAJB sign-in bundle (window.JAJB) so the Firebase-only
// parts of the app — the Live board above all — can be clicked through on
// this PC without Firestore. Data lives in localStorage; other tabs on the
// same origin see changes (the 'storage' event), like Firestore listeners.
// Same rev / conflict rule as jajb.js saveScheduleWeek. ?as=Name picks who
// you are, so two tabs can play two dispatchers. TEST ONLY — never deployed.
//
// ?lat=300 (2026-10-08) adds Firestore-like latency: a read = one round trip, a
// save (transaction: read + commit) = two, a new listener's first snapshot = one
// (none when another listener already holds that doc, like Firestore's shared
// views), a change pushed to listeners = half a round trip. window.JAJB.__mock has
// test hooks: remoteSave (another dispatcher's save), beforeNextSave, failNext, calls.
(function () {
  const params = new URLSearchParams(location.search);
  const name = params.get('as') || 'Jose (test)';
  const LAT = Math.max(0, parseInt(params.get('lat'), 10) || 0);
  const K = 'jajbmock:';
  const get = (k) => { try { return JSON.parse(localStorage.getItem(K + k)); } catch { return null; } };
  const put = (k, v) => localStorage.setItem(K + k, JSON.stringify(v));
  const now = () => new Date().toISOString();
  const calls = {};
  const count = (k) => { calls[k] = (calls[k] || 0) + 1; };
  // listeners: {path, read, cb, last, live}. A change re-reads each one and calls it only when its
  // data changed (Firestore fires a listener only for a real change).
  const listeners = new Set();
  const deliver = (L) => {
    if (!L.live) return;
    let v, s;
    try { v = L.read(); s = JSON.stringify(v); } catch (e) { console.error(e); return; }
    if (L.got && s === L.last) return;
    L.got = true; L.last = s;
    try { L.cb(v); } catch (e) { console.error(e); }
  };
  const fire = () => listeners.forEach((L) => setTimeout(() => deliver(L), LAT / 2));
  window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith(K)) fire(); });
  function listen(path, read, cb) {
    count('listen');
    const shared = [...listeners].some((x) => x.path === path && x.got);
    const L = { path, read, cb, live: true, got: false, last: null };
    listeners.add(L);
    setTimeout(() => deliver(L), shared ? 0 : LAT);
    return () => { L.live = false; listeners.delete(L); };
  }
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let beforeNextSave = null, failNext = null;

  function weeks() { return get('weeks') || {}; }
  function writeWeek(week, w, by) {
    const all = weeks();
    const old = all[week] ? all[week].meta : null;
    const rev = old ? old.rev : 0;
    const next = rev + 1;
    const fresh = !old || w.publish;
    if (w.engine.length >= 900000 || w.summary.length >= 900000) throw new Error('too big for Firestore');
    all[week] = {
      meta: { week, label: w.label, num: parseInt(w.num, 10) || 0, rev: next, stats: w.stats || {},
        by, at: now(), publishedBy: fresh ? by : old.publishedBy, publishedAt: fresh ? now() : old.publishedAt },
      summary: w.summary, engine: w.engine,
    };
    put('weeks', all);
    const log = get('log/' + week) || [];
    for (const l of (w.log || [])) log.push({ text: l.text, kind: l.kind, by, at: now(), rev: next });
    put('log/' + week, log);
    fire();
    return next;
  }
  // a doc path as the generic watch() reads it
  function readPath(path) {
    const p = path.split('/');
    if (p[0] === 'actual_hours') return get('actual/' + p[1]);
    if (p[0] === 'schedule_weeks') {
      const w = weeks()[p[1]];
      if (!w) return null;
      if (p.length === 2) return w.meta;
      if (p[2] === 'data' && p[3] === 'summary') return { json: w.summary, rev: w.meta.rev };
      if (p[2] === 'data' && p[3] === 'engine') return { json: w.engine, rev: w.meta.rev };
    }
    return get(path);
  }

  // ?demo=1 (2026-10-08): a made-up week (this week, no engine - the grid still shows) and Route
  // Tracker docs with `routes` / `open`, to see the "has a route" stripes without publishing a week.
  const iso = (d) => d.toISOString().slice(0, 10);
  const sunday = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return d; })();
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dateOf = (base, i) => { const d = new Date(base); d.setDate(d.getDate() + i); return iso(d); };
  if (params.get('demo') === '1' && !weeks()[iso(sunday)]) {
    const wk = iso(sunday), cells = (a) => Object.fromEntries(DAYS.map((d, i) => [d, a[i] || '']));
    const drivers = [
      ['Ana Road', ['10:25 AM', '10:25 AM', '', '10:45 AM', '10:25 AM', '11:05 AM', '']],
      ['Ben Backup', ['', '10:25 AM Backup', '10:25 AM Backup', '', '10:45 AM Backup', '10:45 AM', '']],
      ['Cara Trainer', ['', '10:45 AM TRAIN helper (w/ Dan Trainee)', '10:45 AM', 'Unavailable', '10:45 AM TRAIN helper (w/ Dan Trainee)', '', '']],
      ['Dan Trainee', ['', '10:45 AM TRAIN drives (w/ Cara Trainer)', '', '', '10:45 AM TRAIN drives (w/ Cara Trainer)', '10:45 AM', '']],
      ['Eve Extra', ['', '', 'Unavailable', '', '', '11:25 AM', '11:25 AM']],
      ['Finn Callout', ['10:45 AM', 'Called out', '10:45 AM', '11:05 AM', '', '', '']],
      // the "Route Tracker and the schedule don't match" card + backup overlay (2026-10-08)
      ['Kathy Deaton', ['', 'Unavailable', '', '', '', '', '']],
      ['Gus Fewer', ['', '10:45 AM', '', '', '', '', '']],
      ['Hal Dispatch', ['', 'Dispatch', '', '', '', '', '']],
      ['Ivy Blank', ['', '', '', '', '', '', '']],
    ].map(([n, c]) => ({ name: n, cls: 'free', hours: 30, cells: cells(c), worked_dates: [] }));
    const summary = { limits: { max_7day_hours: 60 }, marks: [], infeasible: [], errors: [], overridden: [],
      days: DAYS.map((d, i) => ({ day: d, date: dateOf(sunday, i), open: true, routes: 4, routes_filled: 4, backup: 1, backup_filled: 1 })),
      drivers };
    const all = weeks();
    all[wk] = { meta: { week: wk, label: 'Demo week', num: 41, rev: 1, stats: {}, by: 'demo', at: now(), publishedBy: 'demo', publishedAt: now() },
      summary: JSON.stringify(summary), engine: '' };
    put('weeks', all);
    // Route Tracker: route days up to today (codes known or not), an open day today, a route nobody scheduled
    const d = (i) => dateOf(sunday, i), t = new Date().getDay();
    const doc = { drivers: {
      a: { name: 'Ana Road', keys: ['ana|road'], days: { [d(0)]: 10, [d(1)]: 9.5 }, routes: { [d(0)]: 'CX12', [d(1)]: 'CX14', [d(3)]: '' }, open: t >= 4 ? [d(4)] : [] },
      b: { name: 'Ben Backup', keys: ['ben|backup'], days: { [d(1)]: 2, [d(2)]: 9 }, routes: { [d(2)]: 'CX20' }, bk: { [d(1)]: 2 }, start: { [d(2)]: '10:25' } },
      c: { name: 'Cara Trainer', keys: ['cara|trainer'], days: { [d(1)]: 10 }, routes: { [d(1)]: 'CX31' } },
      e: { name: 'Eve Extra', keys: ['eve|extra'], days: { [d(1)]: 10, [d(2)]: 9 }, routes: { [d(1)]: 'CX44', [d(2)]: '' } },
      // backups (bk) + route clock-in (start), and each mismatch case on Monday (2026-10-08)
      dt: { name: 'Dan Trainee', keys: ['dan|trainee'], days: { [d(1)]: 2 }, bk: { [d(1)]: 2 } },
      k: { name: 'Kathy Deaton', keys: ['kathy|deaton'], days: { [d(1)]: 2 }, bk: { [d(1)]: 2 } },
      g: { name: 'Gus Fewer', keys: ['gus|fewer'], days: { [d(1)]: 2 }, bk: { [d(1)]: 2 } },
      h: { name: 'Hal Dispatch', keys: ['hal|dispatch'], days: { [d(1)]: 10 }, routes: { [d(1)]: 'CX60' }, start: { [d(1)]: '10:45' } },
      i: { name: 'Ivy Blank', keys: ['ivy|blank'], days: { [d(1)]: 2 }, bk: { [d(1)]: 2 } },
      n: { name: 'Nora Notlisted', keys: ['nora|notlisted'], days: { [d(1)]: 10 }, routes: { [d(1)]: 'CX70' }, start: { [d(1)]: '11:05' } },
      f: { name: 'Finn Callout', keys: ['finn|callout'], days: { [d(0)]: 10, [d(1)]: 10 }, routes: { [d(0)]: '', [d(1)]: 'CX50', [d(5)]: 'CX99' } },
    } };
    put('actual/' + wk, doc);
  }

  window.JAJB = {
    ready: Promise.resolve(),
    user: () => ({ email: 'test@example.com' }),
    me: () => ({ name, active: true, apps: { schedule: true } }),
    waitMe: () => Promise.resolve(),
    has: (a) => !(a === 'drivers' && params.get('nodrivers') === '1'),
    signOut: async () => {},
    scheduleGet: async (n) => get('schedule/' + n),
    schedulePut: async (n, f) => put('schedule/' + n, { ...f, by: name, at: now() }),
    scheduleTraining: async () => Object.entries(get('training') || {}).map(([week, v]) => ({ week, ...v })),
    saveScheduleTraining: async (week, label, pairs) => {
      const t = get('training') || {}; t[week] = { label, pairs }; put('training', t);
    },

    // the Driver Dashboard's data (boards/drivers); ?nodrivers=1 = a login without that app.
    // The last two drivers are moved to `leaving`, like the cloud does for roster leavers.
    driverBoardData: async () => {
      if (params.get('nodrivers') === '1') throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
      const r = await fetch('/__board.json');
      if (!r.ok) return null;
      const db = await r.json();
      db.leaving = db.drivers.splice(-2);
      return { db, updated: now(), asof: db.asof };
    },
    scheduleWeeks: async (n) => {
      count('scheduleWeeks');
      await delay(LAT);
      return Object.values(weeks()).map((w) => w.meta)
        .sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, n || 60);
    },
    scheduleWeekData: async (week) => {
      count('scheduleWeekData');
      await delay(LAT || 80);
      const w = weeks()[week];
      return w ? { meta: w.meta, summary: w.summary, engine: w.engine } : null;
    },
    watchScheduleWeek: (week, cb) => listen('schedule_weeks/' + week, () => { const w = weeks()[week]; return w ? w.meta : null; }, cb),
    watchScheduleLog: (week, cb) => listen('log/' + week, () => ((get('log/' + week)) || []).slice().reverse(), cb),
    saveScheduleWeek: async (week, w) => {
      count('saveScheduleWeek');
      await delay(LAT ? LAT * 2 : 150);
      if (beforeNextSave) { const f = beforeNextSave; beforeNextSave = null; await f(); }
      if (failNext) { const k = failNext; failNext = null; throw new Error(k === 'offline' ? 'Failed to get document because the client is offline.' : String(k)); }
      if (params.get('offline') === '1') throw new Error('Failed to get document because the client is offline.');
      const old = weeks()[week] ? weeks()[week].meta : null;
      const rev = old ? old.rev : 0;
      if (w.expectRev != null && rev !== w.expectRev) {
        const e = new Error((old && old.by ? old.by : 'Someone') + ' changed this week a moment ago.');
        e.code = 'conflict'; e.by = old && old.by;
        throw e;
      }
      return writeWeek(week, w, name);
    },
    // Route Tracker's clock-outs: actual_hours/{week} from localStorage 'jajbmock:actual/{week}';
    // schedule_weeks/{week}[/data/summary|engine] like Firestore ({json, rev} for the data docs)
    watch: (path, cb) => listen(path, () => readPath(path), cb),
    watchScheduleNotes: (week, cb) => listen('notes/' + week, () => get('notes/' + week) || {}, cb),
    saveScheduleNote: async (week, nm, day, text) => {
      await delay(LAT);
      const all = get('notes/' + week) || {}, k = day + '|' + nm, t = String(text || '').trim();
      if (t) all[k] = { name: nm, day, text: t, by: name, at: now() }; else delete all[k];
      put('notes/' + week, all); fire();
    },
    watchScheduleConfirms: (week, cb) => listen('confirm/' + week, () => get('confirm/' + week) || {}, cb),
    saveScheduleConfirm: async (week, nm, day, answer, excused) => {
      await delay(LAT);
      const all = get('confirm/' + week) || {}, k = day + '|' + nm;
      if (answer) all[k] = { name: nm, day, answer, by: name, at: now(), ...(answer === 'callout' && excused ? { excused: true } : {}) }; else delete all[k];
      put('confirm/' + week, all); fire();
    },
    // requested days off for weeks not built yet (2026-10-09): schedule_timeoff/{week}/days
    watchScheduleTimeoff: (week, cb) => listen('timeoff/' + week, () => get('timeoff/' + week) || {}, cb),
    saveScheduleTimeoff: async (week, nm, day, note) => {
      await delay(LAT);
      const all = get('timeoff/' + week) || {};
      all[day + '|' + nm] = { name: nm, day, note: String(note || '').trim().slice(0, 300), by: name, at: now() };
      put('timeoff/' + week, all); fire();
    },
    deleteScheduleTimeoff: async (week, nm, day) => {
      await delay(LAT);
      const all = get('timeoff/' + week) || {};
      delete all[day + '|' + nm];
      put('timeoff/' + week, all); fire();
    },
    // VET / VTO offers (Driver App SPEC-v2 §6, 2026-10-12): schedule_offers/{id} in 'offers', takes in
    // 'offertakes/{id}' — same fields and checks as jajb.js (timestamps as ms). Drivers' takes come from
    // __mock.takeOffer below (the Driver App's server makes them for real).
    watchScheduleOffers: (week, cb) => listen('offers', () => {
      const from = new Date(); from.setDate(from.getDate() - 14);
      return Object.values(get('offers') || {})
        .filter((o) => (week ? o.week === String(week) : o.date >= iso(from)))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.at - b.at);
    }, cb),
    watchOfferTakes: (id, cb) => listen('offertakes/' + id, () => Object.values(get('offertakes/' + id) || {})
      .sort((a, b) => a.at - b.at), cb),
    saveScheduleOffer: async (f) => {
      await delay(LAT);
      f = f || {};
      if (f.kind !== 'vet' && f.kind !== 'vto') throw new Error('kind must be vet or vto');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.date || ''))) throw new Error('date must be YYYY-MM-DD');
      const slots = Number(f.slots);
      if (!Number.isInteger(slots) || slots < 1 || slots > 50) throw new Error('spots must be 1 to 50');
      const t = new Date(f.date + 'T12:00:00'), sun = new Date(t); sun.setDate(t.getDate() - t.getDay());
      const tiers = (x) => (Array.isArray(x) ? x : []).map(String).filter(Boolean).slice(0, 10);
      const hrs = (h, d) => (h == null || h === '' ? d : Math.max(0, Math.min(168, Number(h) || 0)));
      const a = f.audience || {}, mode = f.mode === 'window' ? 'window' : 'fcfs', at = Date.now();
      const id = 'of' + at.toString(36) + Math.random().toString(36).slice(2, 6);
      const o = { id, v: 1, kind: f.kind, week: iso(sun), date: f.date, day: DAYS[t.getDay()], wave: String(f.wave || ''),
        slots, status: 'open', taken: 0, audience: { tiers: tiers(a.tiers), maxWeekHours: hrs(a.maxWeekHours, null) },
        mode, note: String(f.note || '').trim().slice(0, 300), by: name, at, decideAt: 0, closedAt: 0 };
      if (f.kind === 'vet') o.role = f.role === 'backup' ? 'backup' : 'road';
      if (mode === 'window') {
        const p = f.priority || {};
        o.windowHours = hrs(f.windowHours, 24);
        o.decideAt = at + o.windowHours * 3600000;
        o.priority = { tiers: tiers(p.tiers), maxWeekHours: hrs(p.maxWeekHours, 40) };
      }
      const all = get('offers') || {}; all[id] = o; put('offers', all); fire();
      return id;
    },
    closeScheduleOffer: async (id) => {
      await delay(LAT);
      const all = get('offers') || {};
      if (!all[id]) throw new Error('No such offer.');
      Object.assign(all[id], { status: 'closed', closedBy: name, closedAt: Date.now() });
      put('offers', all); fire();
    },
    decideCounter: async (id, tid, yes) => {
      await delay(LAT);
      const tk = get('offertakes/' + id) || {};
      if (!tk[tid] || tk[tid].status !== 'pending') throw new Error('That request was already answered.');
      Object.assign(tk[tid], { status: yes ? 'approved' : 'declined', decidedBy: name });
      put('offertakes/' + id, tk); fire();
      return { ok: true };
    },
    // Drivers' trades (Driver App SPEC-v3, 2026-10-15): driver_trades/{id} in 'trades', props in
    // 'tradeprops/{id}' (times as ms, like jajb.js). Read only; __mock.putTrade / putTradeProp play the
    // Driver App's server and the hub.
    watchDriverTrades: (week, cb) => listen('trades', () => {
      const from = new Date(); from.setDate(from.getDate() - 14);
      return Object.values(get('trades') || {})
        .filter((t) => (week ? t.week === String(week) || (t.deal && t.deal.week === String(week)) : t.date >= iso(from)))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.at - b.at);
    }, cb),
    watchTradeProps: (id, cb) => listen('tradeprops/' + id, () => Object.values(get('tradeprops/' + id) || {})
      .sort((a, b) => a.at - b.at), cb),
    deleteScheduleWeek: async (week) => {
      const all = weeks(); delete all[week]; put('weeks', all);
      localStorage.removeItem(K + 'log/' + week);
      fire();
    },

    // test hooks (not in jajb.js)
    __mock: {
      LAT, calls,
      // another dispatcher's save of the week: w = {summary, engine, label, num, stats, log}
      remoteSave: (week, w, by = 'Maria (test)') => writeWeek(week, w, by),
      // runs inside our next save, before its rev check (e.g. a remoteSave = a real conflict)
      beforeNextSave: (f) => { beforeNextSave = f; },
      // our next save throws: 'offline' or any message
      failNext: (k) => { failNext = k || 'offline'; },
      set: (k, v) => { put(k, v); fire(); },
      // a driver takes an offer (what the Driver App's drv_offer does, simplified): t = {tid, name, status
      // ('approved' | 'waiting' | 'pending' | 'applied' | 'refused' | 'declined'), counter, role, why}.
      // A non-counter approved / applied take uses a slot; the offer is filled when they're all used.
      takeOffer: (id, t) => {
        const all = get('offers') || {}, o = all[id];
        if (!o) throw new Error('No such offer.');
        const tk = get('offertakes/' + id) || {};
        const tt = { tid: t.tid, name: t.name || t.tid, at: Date.now(), role: t.role || o.role || '',
          counter: !!t.counter, status: t.status || 'approved', ...(t.why ? { why: t.why } : {}) };
        tk[t.tid] = tt;
        put('offertakes/' + id, tk);
        if (!tt.counter && (tt.status === 'approved' || tt.status === 'applied')) {
          o.taken = (o.taken || 0) + 1;
          if (o.taken >= o.slots && o.status === 'open') o.status = 'filled';
          put('offers', all);
        }
        fire();
      },
      // a trade as the Driver App's server / the hub writes it: t = {id, giver: {tid, name}, week, date, day,
      // role, wave, swapDays, status, deal?, at, deadline, agreedAt?, appliedAt?, refusedAt?, why?, ...}
      // (missing at = now); a later call with the same id merges into it
      putTrade: (t) => {
        const all = get('trades') || {};
        all[t.id] = { v: 1, swapDays: [], status: 'open', at: Date.now(), ...(all[t.id] || {}), ...t };
        put('trades', all); fire();
      },
      // a trade offer to the giver: p = {tid, name, date, role, wave, status, at?}
      putTradeProp: (id, p) => {
        const all = get('tradeprops/' + id) || {};
        all[p.tid] = { at: Date.now(), status: 'pending', ...p };
        put('tradeprops/' + id, all); fire();
      },
      get,
      reset: () => { Object.keys(localStorage).filter((k) => k.startsWith(K)).forEach((k) => localStorage.removeItem(k)); },
    },
  };
}());

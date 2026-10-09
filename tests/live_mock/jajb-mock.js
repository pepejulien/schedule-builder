// A stand-in for the JAJB sign-in bundle (window.JAJB) so the Firebase-only
// parts of the app — the Live board above all — can be clicked through on
// this PC without Firestore. Data lives in localStorage; other tabs on the
// same origin see changes (the 'storage' event), like Firestore listeners.
// Same rev / conflict rule as jajb.js saveScheduleWeek. ?as=Name picks who
// you are, so two tabs can play two dispatchers. TEST ONLY — never deployed.
(function () {
  const params = new URLSearchParams(location.search);
  const name = params.get('as') || 'Jose (test)';
  const K = 'jajbmock:';
  const get = (k) => { try { return JSON.parse(localStorage.getItem(K + k)); } catch { return null; } };
  const put = (k, v) => localStorage.setItem(K + k, JSON.stringify(v));
  const now = () => new Date().toISOString();
  const listeners = new Set();
  const fire = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith(K)) fire(); });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function weeks() { return get('weeks') || {}; }

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
      b: { name: 'Ben Backup', keys: ['ben|backup'], days: { [d(2)]: 9 }, routes: { [d(2)]: 'CX20' } },
      c: { name: 'Cara Trainer', keys: ['cara|trainer'], days: { [d(1)]: 10 }, routes: { [d(1)]: 'CX31' } },
      e: { name: 'Eve Extra', keys: ['eve|extra'], days: { [d(1)]: 10, [d(2)]: 9 }, routes: { [d(1)]: 'CX44', [d(2)]: '' } },
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
    scheduleWeeks: async (n) => Object.values(weeks()).map((w) => w.meta)
      .sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, n || 60),
    scheduleWeekData: async (week) => {
      await delay(80);
      const w = weeks()[week];
      return w ? { meta: w.meta, summary: w.summary, engine: w.engine } : null;
    },
    watchScheduleWeek: (week, cb) => {
      const f = () => { const w = weeks()[week]; cb(w ? w.meta : null); };
      listeners.add(f); setTimeout(f, 0);
      return () => listeners.delete(f);
    },
    watchScheduleLog: (week, cb) => {
      const f = () => cb(((get('log/' + week)) || []).slice().reverse());
      listeners.add(f); setTimeout(f, 0);
      return () => listeners.delete(f);
    },
    saveScheduleWeek: async (week, w) => {
      await delay(150);
      if (params.get('offline') === '1') throw new Error('Failed to get document because the client is offline.');
      const all = weeks();
      const old = all[week] ? all[week].meta : null;
      const rev = old ? old.rev : 0;
      if (w.expectRev != null && rev !== w.expectRev) {
        const e = new Error((old && old.by ? old.by : 'Someone') + ' changed this week a moment ago.');
        e.code = 'conflict'; e.by = old && old.by;
        throw e;
      }
      const next = rev + 1;
      const fresh = !old || w.publish;
      if (w.engine.length >= 900000 || w.summary.length >= 900000) throw new Error('too big for Firestore');
      all[week] = {
        meta: { week, label: w.label, num: parseInt(w.num, 10) || 0, rev: next, stats: w.stats || {},
          by: name, at: now(), publishedBy: fresh ? name : old.publishedBy, publishedAt: fresh ? now() : old.publishedAt },
        summary: w.summary, engine: w.engine,
      };
      put('weeks', all);
      const log = get('log/' + week) || [];
      for (const l of (w.log || [])) log.push({ text: l.text, kind: l.kind, by: name, at: now(), rev: next });
      put('log/' + week, log);
      fire();
      return next;
    },
    // Route Tracker's clock-outs: actual_hours/{week} from localStorage 'jajbmock:actual/{week}'
    watch: (path, cb) => {
      const f = () => cb(get(path.replace(/^actual_hours\//, 'actual/')));
      listeners.add(f); setTimeout(f, 0);
      return () => listeners.delete(f);
    },
    watchScheduleNotes: (week, cb) => {
      const f = () => cb(get('notes/' + week) || {});
      listeners.add(f); setTimeout(f, 0);
      return () => listeners.delete(f);
    },
    saveScheduleNote: async (week, nm, day, text) => {
      const all = get('notes/' + week) || {}, k = day + '|' + nm, t = String(text || '').trim();
      if (t) all[k] = { name: nm, day, text: t, by: name, at: now() }; else delete all[k];
      put('notes/' + week, all); fire();
    },
    watchScheduleConfirms: (week, cb) => {
      const f = () => cb(get('confirm/' + week) || {});
      listeners.add(f); setTimeout(f, 0);
      return () => listeners.delete(f);
    },
    saveScheduleConfirm: async (week, nm, day, answer, excused) => {
      const all = get('confirm/' + week) || {}, k = day + '|' + nm;
      if (answer) all[k] = { name: nm, day, answer, by: name, at: now(), ...(answer === 'callout' && excused ? { excused: true } : {}) }; else delete all[k];
      put('confirm/' + week, all); fire();
    },
    deleteScheduleWeek: async (week) => {
      const all = weeks(); delete all[week]; put('weeks', all);
      localStorage.removeItem(K + 'log/' + week);
      fire();
    },
  };
}());

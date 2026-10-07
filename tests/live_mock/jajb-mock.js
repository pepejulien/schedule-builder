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
    deleteScheduleWeek: async (week) => {
      const all = weeks(); delete all[week]; put('weeks', all);
      localStorage.removeItem(K + 'log/' + week);
      fire();
    },
  };
}());

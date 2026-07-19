// Verbatim port of the JAJB driver board's own scoring logic.
// Source: https://jajb-driver-board.netlify.app/ (metrics / tier / rateFields /
// expInWin / inWin). Ported so the app derives the SAME tier badges Jose sees,
// instead of scraping the rendered table (SKILL.md, 2026-07-11).
//
// Window is always 30 days for schedule day-targets. Tier ladder (the board's
// 2nd tier() definition, which wins): ncns>=2 || high>=2 || strikes>=3 ->
// Termination review; routes<1 -> Unrated; else by rateScore.
//
// If the board changes its scoring, the tests/board-metrics fixture test fails
// loudly and the wizard falls back to manual tier entry.

export const TIER_ORDER = [
  'Termination review', 'Underperforming', 'Fair', 'Solid', 'Top performer', 'Unrated',
];

function makeInWin(asofDate) {
  const days = (iso) => (asofDate - new Date(iso + 'T00:00:00')) / 86400000;
  return (iso, w) => (w === 0 ? true : days(iso) <= (w - 1));
}

function expInWin(dr, w, inWin) {
  let R = 0, P = 0;
  const ex = dr.exp || [];
  for (let i = 0; i < ex.length; i++) {
    if (inWin(ex[i][0], w)) { R += ex[i][1]; P += ex[i][2]; }
  }
  return [R, P];
}

function rateFields(dr, m, w, inWin) {
  const e = expInWin(dr, w, inWin);
  const KR = 8, KP = 800;
  m.routes = Math.round(e[0] * 10) / 10;
  m.pkgs = Math.round(e[1]);
  let dsb = 0;
  (dr.events || []).forEach((ev) => {
    if (ev.track === 'dsb' && inWin(ev.d, w)) dsb += (ev.mag || 1);
  });
  m.dsb = dsb;
  const sp = 1.5 * m.low + 4 * m.high + 1.5 * m.stuck + m.oodt / 25 + (m.rescpk || 0) / 25;
  const vp = 3 * m.cdf + 15 * dsb;
  m.rateScore = -(Math.round((sp / (m.routes + KR) * 100 + vp / (m.pkgs + KP) * 1000) * 10) / 10);
  m.enough = m.routes >= 1;
  return m;
}

function tier(m) {
  if (m.ncns >= 2 || m.high >= 2 || m.strikes >= 3) return 'Termination review';
  if (!m.enough) return 'Unrated';
  const r = m.rateScore;
  if (r >= -5) return 'Top performer';
  if (r >= -15) return 'Solid';
  if (r >= -35) return 'Fair';
  if (r >= -60) return 'Underperforming';
  return 'Termination review';
}

function metrics(dr, w, PEN, MPR, inWin) {
  const m = { low: 0, high: 0, ncns: 0, callout: 0, oodt: 0, cdf: 0, cdfbeh: 0, rg: 0, resc: 0, rescpk: 0, stuck: 0 };
  (dr.events || []).forEach((e) => {
    if (!inWin(e.d, w)) return;
    if (e.track === 'safety') m.low++;
    else if (e.track === 'highsev') m.high++;
    else if (e.track === 'ncns') m.ncns++;
    else if (e.track === 'callout') m.callout++;
    else if (e.track === 'oodt') { if (!(e.detail || '').includes('not-at-fault')) m.oodt += e.mag; }
    else if (e.track === 'cdf') { m.cdf++; if ((e.detail || '').includes('BEHAVIORAL')) m.cdfbeh++; }
    else if (e.track === 'rescue_given') m.rg++;
    else if (e.track === 'rescue') { m.resc++; m.rescpk += (e.mag || 0); }
    else if (e.track === 'stuck' && (e.detail || '').includes('at-fault') && !(e.detail || '').includes('not-at-fault')) m.stuck++;
  });
  m.strikes = (dr.strikes || []).filter((d) => inWin(d, w)).length;
  m.backing = dr.backing ? dr.backing[0] : null;
  m.backingSev = (dr.backing && dr.backing[1]) || 0;
  m.conduct = -Math.round((PEN.lowsev * m.low + PEN.highsev * m.high + PEN.ncns * m.ncns
    + PEN.callout * m.callout + PEN.cdf * m.cdf + PEN.strike * m.strikes
    + PEN.stuck * m.stuck + (PEN.dsb || 0) * (m.dsb || 0)) * 10) / 10;
  m.merit = m.rg * MPR;
  rateFields(dr, m, w, inWin);
  m.tier = tier(m);
  return m;
}

// Guard against board schema drift — fail loud rather than mis-tier silently.
export function validateDb(db) {
  const problems = [];
  if (!db || typeof db !== 'object') return ['board data is empty or not an object'];
  if (!db.asof) problems.push("missing 'asof' date");
  if (!db.pen) problems.push("missing 'pen' penalty weights");
  if (db.meritPerRescue == null) problems.push("missing 'meritPerRescue'");
  if (!Array.isArray(db.drivers) || db.drivers.length === 0) problems.push("missing/empty 'drivers'");
  else if (!('events' in db.drivers[0])) problems.push("drivers have no 'events' field");
  return problems;
}

// Returns [{name, tier, routes, rate, rateScore, metrics}] for every board driver.
export function computeTiers(db, windowDays = 30) {
  const asof = new Date(db.asof + 'T00:00:00');
  const { pen: PEN, meritPerRescue: MPR } = db;
  const inWin = makeInWin(asof);
  return (db.drivers || []).map((dr) => {
    const m = metrics(dr, windowDays, PEN, MPR, inWin);
    return {
      name: dr.name,
      tier: m.tier,
      routes: m.routes,
      rate: m.enough ? m.rateScore : null,
      rateScore: m.rateScore,
      metrics: m,
    };
  });
}

// SKILL.md sanity check: a full-time driver runs ~13-19 routes in 30 days; a max
// above ~25 means a wrong window slipped in. Returns a warning string or null.
export function sanityWarnings(tiers, asof) {
  const warns = [];
  const maxRoutes = Math.max(0, ...tiers.map((t) => t.routes || 0));
  if (maxRoutes > 25) {
    warns.push(`A driver shows ${maxRoutes} routes in 30 days (expected max ~25). `
      + 'The board window may be wrong — double-check the tiers before building.');
  }
  if (asof) {
    const ageDays = Math.round((Date.now() - new Date(asof + 'T00:00:00')) / 86400000);
    if (ageDays > 9) warns.push(`Board data is ${ageDays} days old (as of ${asof}).`);
  }
  return warns;
}

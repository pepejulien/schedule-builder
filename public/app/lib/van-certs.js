// Amazon van certification — CDV / EDV (Jose 2026-11-11). One home: the cloud roster's vanCert, which the
// nightly roster sync reads off Amazon's People list (completed qualifications only — a pending EDV is
// not EDV). It reaches the apps as Firestore dispatch/lists.driverInfo[name].cert = "EDV" | "CDV" | "".
// EDV covers CDV: an EDV-certified driver may drive both kinds of van.
// The Live board's van filter uses this. The Vehicle Assigner ("Morning operations/site/index.html",
// vanBlock / canDriveVan) keeps its own copy of the same rule so a safety check never waits on a
// network load — change both together.

export const CERTS = ['CDV', 'EDV'];

// may a driver with `cert` drive a van that needs `need` ("CDV" | "EDV" | "" = any van)?
export function canDrive(cert, need) {
  if (!need) return true;
  if (need === 'EDV') return cert === 'EDV';
  if (need === 'CDV') return cert === 'EDV' || cert === 'CDV';
  return true;
}

export function certLabel(cert) {
  return cert === 'EDV' ? 'EDV + CDV' : cert === 'CDV' ? 'CDV' : '';
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const flKey = (s) => { const t = fold(s).replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean); return t.length ? t[0] + '|' + t[t.length - 1] : ''; };

// dispatch/lists.driverInfo {name: {tid, hireDate, cert}} -> lookup(name, tid) -> "EDV" | "CDV" | "" | null
// (null = not on Amazon's list / unknown). Transporter ID first, then the exact name, then first|last
// when only one person has it — never a guess between two people.
export function certIndex(info) {
  const byTid = new Map(), byName = new Map(), byFl = new Map(), flDup = new Set();
  for (const [name, d] of Object.entries(info || {})) {
    if (!d || typeof d !== 'object') continue;
    const cert = d.cert === 'EDV' || d.cert === 'CDV' ? d.cert : '';
    if (d.tid) byTid.set(String(d.tid).trim().toUpperCase(), cert);
    byName.set(fold(name), cert);
    const k = flKey(name);
    if (byFl.has(k) && byFl.get(k) !== cert) flDup.add(k);
    byFl.set(k, cert);
  }
  return (name, tid) => {
    const t = String(tid || '').trim().toUpperCase();
    if (t && byTid.has(t)) return byTid.get(t);
    const n = fold(name);
    if (byName.has(n)) return byName.get(n);
    const k = flKey(name);
    return k && byFl.has(k) && !flDup.has(k) ? byFl.get(k) : null;
  };
}

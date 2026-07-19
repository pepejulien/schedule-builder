// Name normalization + matching. `resolveFuzzy` is a faithful port of the
// solver's resolve() so the app can pre-flight every config name against the
// roster and block Build on anything the solver would reject (strict_names).
//
// Matching tiers (strongest first):
//   exact  — normalized strings identical
//   token  — same full token SET (SKILL.md: full-name comparison, so "Hunt"
//            never auto-matches "Hunter"); safe to auto-apply
//   fuzzy  — solver-style token-substring match; shown as a SUGGESTION to confirm
//   none   — no match; HR picks from a dropdown

export function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokens(s) {
  return norm(s).split(' ').filter(Boolean);
}

// Solver's resolve(): every query token must be a substring of some candidate
// token. Returns the list of matching roster names (as given).
export function resolveFuzzy(name, rosterNames) {
  const q = tokens(name);
  if (!q.length) return [];
  return rosterNames.filter((cand) => {
    const ct = tokens(cand);
    return q.every((tok) => ct.some((rt) => rt.includes(tok)));
  });
}

function sameTokenSet(a, b) {
  const ta = tokens(a).slice().sort();
  const tb = tokens(b).slice().sort();
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

// Match one external name (board / prefs) to a roster name.
// aliases: { [normExternal]: rosterName } — confirmed pairs that auto-apply.
export function matchName(query, rosterNames, aliases = {}) {
  const nq = norm(query);
  const alias = aliases[nq];
  if (alias && rosterNames.includes(alias)) {
    return { status: 'alias', match: alias, candidates: [alias] };
  }
  const exact = rosterNames.find((r) => norm(r) === nq);
  if (exact) return { status: 'exact', match: exact, candidates: [exact] };

  const tok = rosterNames.filter((r) => sameTokenSet(r, query));
  if (tok.length === 1) return { status: 'token', match: tok[0], candidates: tok };

  const fuzzy = resolveFuzzy(query, rosterNames);
  if (fuzzy.length === 1) return { status: 'fuzzy', match: fuzzy[0], candidates: fuzzy };
  if (fuzzy.length > 1) return { status: 'ambiguous', match: null, candidates: fuzzy };

  return { status: 'none', match: null, candidates: [] };
}

// Pre-flight: for a list of config names that must resolve to exactly one roster
// name, return the ones the solver would reject. Mirrors resolve_one()'s
// unmatched/ambiguous failure.
export function preflightNames(configNames, rosterNames) {
  const problems = [];
  for (const nm of configNames) {
    const hits = resolveFuzzy(nm, rosterNames);
    if (hits.length === 0) problems.push({ name: nm, reason: 'no roster match' });
    else if (hits.length > 1) problems.push({ name: nm, reason: `ambiguous (${hits.join(', ')})` });
  }
  return problems;
}

export const DEFAULT_ALIASES = {
  kara: 'Cara Amos',
  grace: 'Greyson Turner',
};

/** Navigate resolution (B6).
 *
 * navigate is visual-primary movement. The plan's hard rule: if the
 * target is not a real place, FAIL GRACEFULLY with a fuzzy
 * suggestion ("don't see an X — did you mean Y?") — NEVER invent a
 * diagram for a place that doesn't exist (no GENERATE for navigate).
 *
 * Pure + deterministic so the resolution and the suggestion are
 * identical every run and unit-testable without the LLM.
 */

export interface NavArea {
  id: string;
  name: string;
  affectedFiles?: string[];
}

export type NavResolution =
  | { kind: 'hit'; areaId: string; areaName: string }
  | { kind: 'miss'; suggestion?: string };

function norm(s: string): string {
  return s.toLowerCase().trim();
}

function lcp(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Fuzzy word-overlap score: full credit for a contained word, plus
 *  partial credit for a shared ≥4-char prefix (so "authn" still
 *  points at "Authentication"). Deterministic. */
function score(target: string, candidate: string): number {
  const cWords = norm(candidate).split(/[\s/_.-]+/);
  let s = 0;
  for (const part of norm(target).split(/[\s/_.-]+/)) {
    if (part.length < 2) continue;
    if (norm(candidate).includes(part)) {
      s += part.length;
      continue;
    }
    let best = 0;
    for (const w of cWords) {
      const p = lcp(part, w);
      if (p >= 4) best = Math.max(best, p);
    }
    s += best;
  }
  return s;
}

export function resolveNavigation(target: string, areas: NavArea[]): NavResolution {
  const t = norm(target);
  if (!t || areas.length === 0) {
    return { kind: 'miss', suggestion: areas[0]?.name };
  }

  // 1. exact-ish: name contains the target, or a file does.
  const direct = areas.find(
    a =>
      norm(a.name).includes(t) ||
      (a.affectedFiles ?? []).some(f => norm(f).includes(t)),
  );
  if (direct) return { kind: 'hit', areaId: direct.id, areaName: direct.name };

  // 2. miss → closest by word overlap, deterministic tiebreak by name.
  const ranked = areas
    .map(a => ({
      a,
      s: Math.max(
        score(target, a.name),
        ...(a.affectedFiles ?? []).map(f => score(target, f)),
        0,
      ),
    }))
    .filter(r => r.s > 0)
    .sort((x, y) => y.s - x.s || (x.a.name < y.a.name ? -1 : 1));

  return { kind: 'miss', suggestion: ranked[0]?.a.name };
}

/** The graceful spoken line for a miss. Never implies a place exists
 *  that doesn't; offers the closest real one if any. */
export function navigateMissNarration(target: string, suggestion?: string): string {
  return suggestion
    ? `I don't see "${target}" in the codebase — did you mean ${suggestion}?`
    : `I don't see "${target}" in the codebase. Try naming a module or file you can see.`;
}

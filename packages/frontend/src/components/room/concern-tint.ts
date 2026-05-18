/** Critique concern tint (B5).
 *
 * `critique` tints the nodes it's worried about, IN_PLACE, never
 * swapping layout. The plan's hard requirement: the tint must EXACTLY
 * match the spoken critique — a tint that contradicts the voice is
 * worse than none.
 *
 * We satisfy that deterministically and with ZERO extra LLM cost:
 * derive the concern node set by matching node labels/leaves that are
 * actually NAMED in the critique narration (word-boundary, longest
 * label first so "auth store" wins over "auth"). Because the set is
 * literally "the nodes the voice mentions while critiquing", the
 * visual cannot disagree with the audio.
 */

export interface ConcernNode {
  id: string;
  label?: string;
}

function leaf(id: string): string {
  const p = id.split('/');
  return p[p.length - 1];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Node ids explicitly named in the critique narration. Deterministic:
 *  longest candidate first (specific over generic), de-duplicated,
 *  word-boundary so "core" doesn't match "scorecard". */
export function concernNodeIds(narration: string, nodes: ConcernNode[]): string[] {
  if (!narration) return [];
  const hay = narration.toLowerCase();
  const ranked = [...nodes]
    .map(n => ({ id: n.id, term: (n.label || leaf(n.id)).toLowerCase().trim() }))
    .filter(c => c.term.length >= 2)
    .sort((a, b) => b.term.length - a.term.length);

  // Consume matched spans: once "auth store" matches, blank it out so
  // the generic "auth" can't re-flag the SAME text. A shorter label
  // only counts if it appears somewhere the longer one didn't.
  let remaining = hay;
  const out: string[] = [];
  for (const c of ranked) {
    const re = new RegExp(`\\b${escapeRe(c.term)}\\b`, 'g');
    if (re.test(remaining)) {
      if (!out.includes(c.id)) out.push(c.id);
      remaining = remaining.replace(new RegExp(`\\b${escapeRe(c.term)}\\b`, 'g'), ' ');
    }
  }
  return out;
}

/** Critique is the only skill that drives the concern tint. */
export function isConcernActive(
  skillResult: { skillName?: string } | null | undefined,
): boolean {
  return skillResult?.skillName === 'critique';
}

interface RankedConcern {
  targets?: string[];
  detail?: string;
}

/** The text `concernNodeIds` should match against for the CURRENTLY
 *  active concern. Ranked critique: the active concern's explicit
 *  `targets` (so only nodes that concern is actually about glow, and
 *  the tint MOVES as you step through concerns). When the skill
 *  produced no structured concerns (LLM/structured-call fell back to
 *  plain prose), degrade to the old behaviour — match the narration —
 *  so the tint still works, just less precisely. */
export function activeConcernText(
  skillResult:
    | { narration?: string; visualPayload?: Record<string, unknown> }
    | null
    | undefined,
  activeIndex: number,
): string {
  const concerns = skillResult?.visualPayload?.concerns as RankedConcern[] | undefined;
  if (Array.isArray(concerns) && concerns.length > 0) {
    const i = Math.max(0, Math.min(activeIndex, concerns.length - 1));
    const targets = concerns[i]?.targets;
    if (Array.isArray(targets) && targets.length > 0) {
      return targets.join('. ');
    }
    // Structured concern but no targets named → fall back to THIS
    // concern's prose, not the whole (multi-concern) narration.
    return concerns[i]?.detail ?? '';
  }
  return skillResult?.narration ?? '';
}

/** Canonical comprehension-ladder model — the single source of truth.
 *
 * Pure, no DOM, no color literals: shared by backend (scoring, node
 * enrichment) AND frontend (ladder, legend, header score). Colour is
 * the ONE thing not here — it can't be a CSS `var()` on the backend —
 * so this exports a pure heat-step index (0..5) and the frontend maps
 * it to `var(--heat-N)` in a thin adapter that structurally cannot
 * diverge. The 6-rung order itself comes from COMPREHENSION_ORDER so
 * there is exactly one ordering authority.
 *
 * Spec: docs/VISION-MASTERPLAN.md §1.3 / §3.3.
 */
import {
  type ComprehensionLevel,
  COMPREHENSION_ORDER,
} from './types/comprehension.js';

/** 0 (unknown) .. 5 (confirmed). undefined/unrecognised → 0. */
export function levelOrdinal(level: ComprehensionLevel | undefined | null): number {
  if (!level) return 0;
  const i = COMPREHENSION_ORDER.indexOf(level);
  return i < 0 ? 0 : i;
}

/** Heat-ramp step (0..5). Named separately from {@link levelOrdinal}
 *  so the colour contract is explicit and decoupled from any future
 *  re-ordering of the ladder. 6 rungs ↔ 6 `--heat-*` steps. */
export function levelHeatStep(level: ComprehensionLevel | undefined | null): number {
  return levelOrdinal(level);
}

/** Short human label per rung (legend + overlay). */
export const LEVEL_LABEL: Record<ComprehensionLevel, string> = {
  unknown: 'not yet',
  mentioned: 'mentioned',
  heard: 'heard',
  engaged: 'engaged',
  explained: 'explained',
  confirmed: 'confirmed',
};

/** What ACTION reaches each rung (the learning pathway). The legend
 *  shows "<label> — <reached-by>"; the per-node hover shows the NEXT
 *  rung's entry via {@link nextLevelTrigger}. Single source for both. */
export const LEVEL_REACHED_BY: Record<ComprehensionLevel, string> = {
  unknown: 'not surfaced yet',
  mentioned: 'AI names it',
  heard: '~5s+ narration heard',
  engaged: 'you ask about it',
  explained: 'AI explains it directly',
  confirmed: 'you confirm understanding',
};

/** The pathway caption for a node AT `level`: how to climb to the next
 *  rung. `null` at `confirmed` (terminal — caller shows "fully
 *  confirmed"). */
export function nextLevelTrigger(level: ComprehensionLevel | undefined | null): string | null {
  const ord = levelOrdinal(level);
  if (ord >= COMPREHENSION_ORDER.length - 1) return null;
  return LEVEL_REACHED_BY[COMPREHENSION_ORDER[ord + 1]];
}

/** Minimal structural shape both ComprehensionItem and DiagramNode
 *  satisfy — keeps this module free of backend/frontend node types.
 *  v2 adds the persisted quiz/grill ratio fields. */
export interface Leveled {
  level?: ComprehensionLevel;
  grilled?: boolean;
  quizCorrect?: number;
  quizTotal?: number;
  grillStrong?: number;
  grillAsked?: number;
  /** v3: the node's briefing narration actually finished playing (a
   *  real dwell signal — shown-and-played, not merely emitted). The
   *  sole input to the Seen-coverage metric. */
  seen?: boolean;
}

// ── Active-recall ratios (docs/KNOWLEDGE-MODEL-SPEC.md) ────────────
export type TestedTier = 'grill' | 'regular' | 'none';

export function regularRatio(n: Leveled): number {
  return n.quizTotal && n.quizTotal > 0 ? (n.quizCorrect ?? 0) / n.quizTotal : 0;
}

export function grillRatio(n: Leveled): number {
  return n.grillAsked && n.grillAsked > 0 ? (n.grillStrong ?? 0) / n.grillAsked : 0;
}

/** Best active-recall mastery (monotonic — best ever, never regresses,
 *  consistent with the never-demote rule). */
export function tested(n: Leveled): number {
  return Math.max(regularRatio(n), grillRatio(n));
}

export function testedTier(n: Leveled): TestedTier {
  if (n.grilled === true || (n.grillAsked ?? 0) > 0) return 'grill';
  if ((n.quizTotal ?? 0) > 0) return 'regular';
  return 'none';
}


// ── Knowledge model v3 (docs/KNOWLEDGE-MODEL-SPEC.md) ──────────────
// Two axes per node, both summarised over node ∪ descendants:
//  • Seen   = % of briefings in the subtree whose narration actually
//             finished playing (real dwell — not "we emitted it").
//             Count-based ⇒ inherently slide-weighted; a parent is the
//             same formula one level up; a node counts ITS OWN briefing
//             so a watched overview is never 0.  "layer" is gone —
//             visiting a level is just one more seen unit.
//  • Tested = best of regular-quiz (correct/asked) and grill
//             (strong/asked).  Component shows the SUBTREE AVERAGE of
//             best scores; the title shows the BEST for THIS view only
//             (its own test), null ⇒ "—" (never taken).
export function bestTestPct(n: Leveled): number {
  return Math.round(Math.max(regularRatio(n), grillRatio(n)) * 100);
}
export function hasTest(n: Leveled): boolean {
  return (n.quizTotal ?? 0) > 0 || (n.grillAsked ?? 0) > 0;
}

export interface KnowledgeRoll {
  /** Seen %, over node ∪ descendants (slide-weighted by count). */
  seenPct: number;
  seenCount: number;
  total: number;
  /** Subtree average of each item's best test score (0..100) —
   *  the COMPONENT readout. */
  testedSummary: number;
  /** This node's OWN best test score, or null if never tested —
   *  the TITLE readout ("best for this view, not the summary"). */
  ownBest: number | null;
  ownTier: TestedTier;
  /** This node's own briefing was seen (for the per-node dot/state). */
  seen: boolean;
  grilled: boolean;
}

/** Subtree roll-up for the v3 model. Pure, memoized, cycle-guarded.
 *  Generic over (per-node inputs, parent→children adjacency). */
export function knowledgeRollUp(
  byId: Map<string, Leveled>,
  childrenOf: Map<string, readonly string[]>,
): Map<string, KnowledgeRoll> {
  const subtreeCache = new Map<string, string[]>();
  const visiting = new Set<string>();

  // ids of node ∪ all descendants (cycle-guarded, deduped).
  const subtree = (id: string): string[] => {
    const c = subtreeCache.get(id);
    if (c) return c;
    const acc = new Set<string>([id]);
    if (!visiting.has(id)) {
      visiting.add(id);
      for (const k of childrenOf.get(id) ?? []) {
        if (!byId.has(k)) continue;
        for (const d of subtree(k)) acc.add(d);
      }
      visiting.delete(id);
    }
    const arr = [...acc];
    subtreeCache.set(id, arr);
    return arr;
  };

  const out = new Map<string, KnowledgeRoll>();
  for (const id of byId.keys()) {
    const ids = subtree(id);
    const total = ids.length;
    let seenCount = 0;
    let testSum = 0;
    for (const d of ids) {
      const n = byId.get(d) ?? {};
      if (n.seen === true) seenCount += 1;
      testSum += bestTestPct(n);
    }
    const self = byId.get(id) ?? {};
    out.set(id, {
      seenPct: total > 0 ? Math.round((100 * seenCount) / total) : 0,
      seenCount,
      total,
      testedSummary: total > 0 ? Math.round(testSum / total) : 0,
      ownBest: hasTest(self) ? bestTestPct(self) : null,
      ownTier: testedTier(self),
      seen: self.seen === true,
      grilled: self.grilled === true,
    });
  }
  return out;
}

/** Build parent→children adjacency from a diagram payload's `contains`
 *  edges (from = parent, to = child). */
export function containsAdjacency(
  edges: readonly { from: string; to: string; kind?: string }[],
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'contains') continue;
    const arr = m.get(e.from) ?? [];
    arr.push(e.to);
    m.set(e.from, arr);
  }
  return m;
}

/** Overlay live comprehension onto structural diagram nodes. The
 *  diagram cache is structure-only (its source_hash never tracks
 *  comprehension), so level/grilled MUST be merged at read time from
 *  the live store. Keyed by `briefingId ?? id` (the same key the
 *  extractor uses). Returns shallow clones — never mutates the cached
 *  node objects. Single merge impl reused by the route and tests. */
export function applyComprehension<
  T extends { id: string; briefingId?: string } & Leveled,
>(
  nodes: readonly T[],
  items: readonly ({ itemId: string } & Leveled)[],
): T[] {
  const byId = new Map(items.map((it) => [it.itemId, it]));
  return nodes.map((n) => {
    const hit = byId.get(n.briefingId ?? n.id);
    if (!hit) return { ...n };
    return {
      ...n,
      level: hit.level,
      grilled: hit.grilled === true,
      seen: hit.seen === true,
      quizCorrect: hit.quizCorrect,
      quizTotal: hit.quizTotal,
      grillStrong: hit.grillStrong,
      grillAsked: hit.grillAsked,
    };
  });
}

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
}

// ── Knowledge model v2 (docs/KNOWLEDGE-MODEL-SPEC.md) ──────────────
// Two components: taught (presentation, auto-credited) + tested
// (quiz/grill, the real signal). Weights lowered because being shown
// the screen is now free — it must not read as "40% known".
export const LISTEN_W = 0.25;
export const TEST_W = 0.75;

export type TestedTier = 'grill' | 'regular' | 'none';

/** A node was "taught" once its layer was presented — which the event
 *  stream records as reaching `heard` (briefing delivered / navigated
 *  to). Nothing above `heard` is set passively any more. */
export function taught(n: Leveled): 0 | 1 {
  return levelOrdinal(n.level) >= 2 ? 1 : 0;
}

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

/** This node's OWN knowledge, 0..100: a weighted blend of being shown
 *  the material (cheap) and proving it (the bulk). */
export function layerKnowledge(n: Leveled): number {
  return Math.round(100 * (LISTEN_W * taught(n) + TEST_W * tested(n)));
}

export interface RolledScore {
  /** This node's own knowledge (§2 layer). */
  layer: number;
  /** Roll-up of descendants (mean of children's `combined`); null for
   *  a leaf (nothing beneath). */
  deep: number | null;
  /** What this node contributes to its parent's deep: leaf → layer;
   *  else → mean(layer, deep). Also the node's gradient-fill value. */
  combined: number;
  testedTier: TestedTier;
  grilled: boolean;
}

/** Hierarchical roll-up. Generic over (per-node inputs, parent→children
 *  adjacency) so it works for one diagram payload (adjacency from
 *  `contains` edges) or the full-repo item tree (adjacency from itemId
 *  prefixes). Pure, memoized, cycle-guarded. */
export function rollUp(
  byId: Map<string, Leveled>,
  childrenOf: Map<string, readonly string[]>,
): Map<string, RolledScore> {
  const out = new Map<string, RolledScore>();
  const visiting = new Set<string>();

  const compute = (id: string): RolledScore => {
    const cached = out.get(id);
    if (cached) return cached;
    const input = byId.get(id) ?? {};
    const layer = layerKnowledge(input);
    const tier = testedTier(input);
    const grilled = input.grilled === true;
    // Cycle guard: a node mid-computation contributes as a leaf.
    const kids = visiting.has(id) ? [] : (childrenOf.get(id) ?? []).filter(c => byId.has(c));
    let deep: number | null = null;
    if (kids.length > 0) {
      visiting.add(id);
      const mean = kids.reduce((s, c) => s + compute(c).combined, 0) / kids.length;
      visiting.delete(id);
      deep = Math.round(mean);
    }
    const combined = deep === null ? layer : Math.round((layer + deep) / 2);
    const r: RolledScore = { layer, deep, combined, testedTier: tier, grilled };
    out.set(id, r);
    return r;
  };

  for (const id of byId.keys()) compute(id);
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

export interface KnowledgeScore {
  /** Weighted comprehension as a % of EVERY node (untouched = 0).
   *  An honest whole-project progress bar for the supervisor view. */
  score: number;
  /** % of nodes that have passed a grill/perfect-quiz (QA proof). */
  grillCoverage: number;
  /** Total nodes considered (the denominator). */
  counted: number;
}

/** Project-wide knowledge score. Denominator is ALL items ("% of
 *  everything", per product decision) — untouched nodes drag it down,
 *  so it only rises as the user genuinely learns. Never NaN. */
export function projectKnowledgeScore(items: readonly Leveled[]): KnowledgeScore {
  const counted = items.length;
  if (counted === 0) return { score: 0, grillCoverage: 0, counted: 0 };
  let weight = 0;
  let grilled = 0;
  for (const it of items) {
    weight += levelOrdinal(it.level) / 5;
    if (it.grilled === true) grilled += 1;
  }
  return {
    score: Math.round((100 * weight) / counted),
    grillCoverage: Math.round((100 * grilled) / counted),
    counted,
  };
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
      quizCorrect: hit.quizCorrect,
      quizTotal: hit.quizTotal,
      grillStrong: hit.grillStrong,
      grillAsked: hit.grillAsked,
    };
  });
}

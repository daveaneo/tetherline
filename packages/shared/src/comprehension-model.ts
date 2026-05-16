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
 *  satisfy — keeps this module free of backend/frontend node types. */
export interface Leveled {
  level?: ComprehensionLevel;
  grilled?: boolean;
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
  T extends { id: string; briefingId?: string; level?: ComprehensionLevel; grilled?: boolean },
>(
  nodes: readonly T[],
  items: readonly { itemId: string; level?: ComprehensionLevel; grilled?: boolean }[],
): T[] {
  const byId = new Map(items.map((it) => [it.itemId, it]));
  return nodes.map((n) => {
    const hit = byId.get(n.briefingId ?? n.id);
    if (!hit) return { ...n };
    return { ...n, level: hit.level, grilled: hit.grilled === true };
  });
}

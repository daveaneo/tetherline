/** Heatmap overlay (B1) — the `whats_changed` project-scope visual:
 *  a glance-readable cold→warm comprehension field over the CURRENT
 *  layout while Hermes recaps.
 *
 *  OVERLAY only. This is a pure render-only predicate — it never
 *  triggers a scope swap or mutates the node set, so the "an overlay
 *  never clears the layout" invariant is structural, not defensive.
 *  Area-scope subtree tint is a deliberate follow-up (see
 *  docs/VISUAL-COMPANION-PLAN.md `whats_changed` decision). */
export function heatmapOverlayActive(
  skillResult: { skillName?: string } | null | undefined,
  scope: string | null | undefined,
): boolean {
  if (!skillResult || skillResult.skillName !== 'whats_changed') return false;
  // Project / root scope only. `scope` is HermesDiagram's local view
  // scope; 'project' or null/undefined both mean the root radial map.
  return scope === 'project' || scope == null;
}

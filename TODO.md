# Tetherline — Work To Do

Three known, scoped-out items. Each is independent, none is blocking —
the codebase is fully green (`pnpm verify` ALL GREEN, suite 550/550).
Anchors below are real file:line references as of this writing.

---

## 1. Per-module (drilled-in) heatmap

**Problem.** The `whats_changed` DRIFT heatmap only renders at the
project scope. Drill into a module (e.g. open Core) and ask "what
changed?" → no wash appears. The "what am I behind on" view is
unavailable exactly when you're focused on one area.

**Where.**
- Gate: `packages/frontend/src/components/room/heatmap-overlay.ts:17`
  — `heatmapOverlayActive` returns `scope === 'project' || scope == null`.
  This is the project-only limiter.
- Data path already supports it: `packages/shared/src/change-heat.ts`
  `changeHeatByNode()` already computes per-node drift for
  `module/<key>` and `file/<path>` ids — no new math needed.
- Consumers: `HermesDiagram.tsx:436` (heat memo, bails when
  `!heatmapOverlayActive`), `:862` (per-node `heatmapOverlay` prop).
- Cooling loop: `packages/backend/src/session/manager.ts`
  `coolWalkedArea()` (re-emits `session:heatmap` on walkthrough) —
  verify it still cools correctly when scoped to a module.

**Approach.**
1. Relax `heatmapOverlayActive` to also allow `scope?.startsWith('module/')`.
2. Confirm `heatByNode` memo in `HermesDiagram` keys module/file node
   ids through `changeHeatByNode` (it should already — verify the
   `nodeIds` passed in include the scoped sub-graph ids).
3. Confirm `coolWalkedArea` recompute → re-emit still lands on the
   scoped view (the heatmap is repo-wide; only the *visible* nodes
   change with scope, so this should already work).
4. Keep project scope behaviour byte-identical.

**Manual test / acceptance.**
- `?scene=heatmap` then drill into a module → module's files wash warm
  by drift (red=changed&unreviewed, yellow=stale, green=caught up).
- Live: say "what changed?", drill into Core → Core's files show
  drift; "walk me through the changes" cools walked files to green
  live while still inside the module.
- Project scope unchanged (regenerate scenes; only the heatmap scene +
  any drilled scene should diff intentionally).

**Effort:** moderate. **Risk:** low — shared core already supports it;
the change is mostly relaxing one predicate + verifying wiring.

---

## 2. Real git line-churn

**Problem.** "How much changed" per file is faked.
`packages/backend/src/git/heatmap.ts:59` sets
`linesChanged: changeIntensity * 10  // rough estimate`, where
`changeIntensity` is just the count of commits touching the file in
the last 30 days. We cannot honestly say "40% of this component
changed" — we don't know real line counts.

**Where.**
- `packages/backend/src/git/heatmap.ts` — `computeHeatmap()` already
  walks `git.log({ '--since': '30 days ago', '--name-only': … })`.
  Switch/extend to numstat to get added+deleted per file.
- `linesChanged` flows into `HeatmapEntry` (shared type). Check
  consumers before changing semantics: the DRIFT formula in
  `change-heat.ts` uses `changeIntensity` (commit count), NOT
  `linesChanged`, so making `linesChanged` real is display-only
  unless we deliberately re-weight drift by it.

**Approach.**
1. Use `git log --numstat --since=…` (simple-git supports passing
   `'--numstat': null`) and sum `added + deleted` per file across the
   window → real `linesChanged`.
2. Replace the `* 10` stub with that real sum.
3. Decision to make explicit: keep DRIFT on commit-count (honest,
   current, recommended) and treat `linesChanged` as a precision
   display metric — OR switch `changeIntensity` to line-churn. Do NOT
   silently change drift semantics; if re-weighting, update
   `change-heat.ts` + its unit tests deliberately.
4. Watch perf: numstat over a 30-day log on a large repo is heavier
   than name-only; measure on a real repo.

**Manual test / acceptance.**
- Spot-check a file's `linesChanged` against
  `git log --since="30 days ago" --numstat -- <file>` summed by hand.
- Heatmap visual unchanged if drift stays on commit-count (only the
  underlying number is now real); if re-weighted, the wash intensity
  should track real churn — verify against a known big-diff file.

**Effort:** small–moderate. **Risk:** low (read-only git; one mapper)
— main care is numstat parsing + the explicit drift-weighting decision.

---

## 3. Mobile / tablet visual pass

**Problem.** This polish cycle only ever visually reviewed the
**desktop** proofs. Tablet (768) and mobile (390) renders are
pixel-gated (deterministic, won't regress) but were never inspected by
a human for *layout quality*. The PDF cover itself flags "mobile
chrome dense but functional at 390px" — unverified.

**Where.**
- Proofs already exist: `docs/polish-proof/*-tablet.png` and
  `*-mobile.png` for all ~16 scenes (regenerated every `pnpm verify`).
- Scenes: `?scene=<name>` at the relevant viewport, or read the
  committed proof PNGs.

**Approach.**
1. Walk every scene's `-tablet.png` and `-mobile.png`; flag clipped
   text, overlapping chrome, unreadable strips, dense affordances.
2. Likely suspects to scrutinise first:
   - Header knowledge strip + the `?` legend at 390 (noted dense).
   - Ranked-critique card inside the right drawer at 390 (drawer is
     `w-[42%]` / `max-w-xl`).
   - Pipeline / guided-tour / blast strips wrapping at narrow widths.
   - Review Shelf tabs row at 390.
3. Fix per-scene (responsive tweaks, never raw hex — theme tokens
   only), verify-green, regenerate proofs, re-read.
4. Consider driving this with the `design-review` agent across the
   three viewports rather than by hand.

**Manual test / acceptance.**
- Open each scene at 768 and 390; no clipped/overflowing text, no
  chrome overlap, every strip legible. Golden path: project-map,
  heatmap, concern-tint, grill-screen, knowledge-layer at 390.
- `pnpm verify` stays green; intentional proof diffs only on scenes
  actually adjusted.

**Effort:** moderate (review + targeted fixes). **Risk:** low —
isolated CSS/layout; deterministic scene harness catches regressions.

---

_Status: all three are optional enhancements / verification. The
product is correct and fully green without them._

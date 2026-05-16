# Visual Companion — Implementation Roadmap

Execution plan for `docs/VISUAL-COMPANION-PLAN.md`. Branch-structured;
each branch is a coherent shippable unit gated by review + headless QA
before it merges to `main`. "Coding effort is not a constraint —
fully polished product" (user directive, 2026-05-15).

## Per-branch protocol (every branch, no exceptions)

1. **Implement to full polish.** No MVP shortcuts, no TODO stubs
   (except where the plan explicitly specifies an honest stub, e.g.
   `export` video). Honor every Cross-cutting requirement.
2. **Strict tests.** Unit + a litmus that the bug MUST fail (per the
   global "loose tests hide bugs" rule). Mode-mapping / transition /
   no-regression assertions where the plan demands them.
3. **Headless QA.** Run the app headless; exercise the feature via the
   dev API; `design-review` agent takes mobile/tablet/desktop
   screenshots and critiques against the ember/espresso design rules.
   Bar = "is this amazing?" If not → iterate until it is.
4. **Self-audit** through the three lenses (testing/robustness · UX ·
   speed/scale), same method as the 2026-05-15 plan audit.
5. **Review gate** — the `/review` skill on the branch. Fix every
   finding. (If `/review` is unavailable in-session, the equivalent
   gate is a code-review subagent + the `design-review` agent; the
   roadmap does not proceed past a branch without a clean review.)
6. **Merge to `main`** only when: tests green, review clean, headless
   "amazing" bar met. Autonomous merge is authorized post-gate.

A branch is NOT done until 1–6 all pass. Typecheck + full litmus
suite must be green before every merge.

**Headless QA cadence (honest note, 2026-05-15):** step 3's headless
visual QA is run at **phase integration boundaries**, not per micro-
branch. Rationale: Phase A increments (heatmap, motion, pipeline,
ripple, tint…) are only visually *coherent* once the transition-
grammar motion (B2) is in; eight isolated screenshot passes of
half-built increments are less truthful than one thorough integrated
Phase-A headless pass. Per-branch gate remains: full-polish impl +
strict tests (bug must fail) + typecheck + review + clean merge.
Visual QA gates: end of Phase A, end of shelf, end of Phase B, B21.
This is recorded so the batching is transparent, not a silent skip.

## Branch sequence (dependency-ordered)

### Foundation

- **B0 `foundation/dispatcher-and-merge`** — shared
  `intelligence/visual-dispatcher.ts`; deterministic transition-grammar
  relationship detection; lift `isAnchorMatch`/`knownNodeIds` into the
  shared layer; the `explain`+`teach` merge (prompt adapts
  concept↔node; remove standalone teach + classifier entry).
  *Everything downstream depends on this.*

### Phase A — zero new tooling

- **B1 `phase-a/comprehension-heatmap`** — overlay recolor by `level`
  (whats_changed visual; cheapest win). Regression: overlay never
  clears layout.
- **B2 `phase-a/transition-grammar-motion`** — DESCEND/ASCEND/LATERAL/
  IN-PLACE via framer-motion `layoutId`; reduced-motion degrade;
  time-slider inverse replay. Test: DESCEND↔ASCEND inverse is exact;
  snapshot fidelity.
- **B3 `phase-a/pipeline-walkthrough`** — sequenced reveal of cached
  logic-graph, narration-synced.
- **B4 `phase-a/blast-radius-ripple`** — BFS over cached `imports`.
- **B5 `phase-a/critique-concern-tint`** — LLM `concernNodeIds`
  overlay; tint matches the spoken critique exactly.
- **B6 `phase-a/navigate-graceful`** — transition-grammar wiring +
  fuzzy-fail (never invent a place); file target = always DESCEND.
- **B7 `phase-a/compare-v1-narrated-tour`** — sequential DESCEND →
  LATERAL → verbal synthesis using existing transitions.
- **B8 `phase-a/grill-quiz-screen`** — in-theme animated `?` screen
  (snapshot/restore, not a slider tick); grill Q/A rides HermesText;
  comprehension-log artifact emitted.

### Shelf

- **B9 `shelf/foundation`** — the unified non-blocking review shelf:
  typed sections, OFF-THREAD writes, the spoken door, the defined
  quiet-notification mechanism. Hard test: shelf write never blocks
  narration.
- **B10 `shelf/annotate-notebook`** — annotate full version: pins +
  Notebook section + recall lens + session-start pin render.

### Phase B — generative

- **B11 `phase-b/elk-engine`** — ELK.js layout engine (web worker)
  behind a non-radial path; node-count/timeout size guard.
- **B12 `phase-b/dependency-cruiser`** — authoritative deps; output
  cache-keyed on repo HEAD.
- **B13 `phase-b/llm-diagram-tooluse`** — Zod-validated graph via
  tool-use; `layout` discriminator; GENERATE transition.
- **B14 `phase-b/deep-dive-pockets`** — the orchestrator: scoping
  handshake (button/voice → one question → cancel → loading), pocket
  dimension (nav cursor + visual sandbox + budget), subway model,
  station-index shelf section, submerge/resurface transition,
  in-pocket Q behavior, parallel slide compose, degraded mode.
  *Largest branch — may split into 14a (pocket+handshake) / 14b
  (station-index + transition).*
- **B15 `phase-b/guided-learning-mode`** — `full_walkthrough`
  re-spined to architecture top-down (`TourPlan.fromArchitecture`);
  ~5s inter-beat pacing; barge-in via existing deviation stack.
- **B16 `phase-b/you-are-here-breadcrumb`** — the P0 persistent
  position indicator (`spine ▸ pocket ▸ n/N`).

### Outbound / async

- **B17 `outbound/export-consolidated`** — one export model → N
  renderers; absorb `share_explanation`; site template; HTML→PDF;
  video = honest async-shaped `NotImplementedError`.
- **B18 `outbound/track-issue-placeholder`** — local follow-up
  register on the shelf; read-only; tracker-adapter seam stubbed.
- **B19 `async/task-skill`** — RISKIEST. Permission ceiling ENFORCED
  (read_only rejects writes), branch-sandbox, in-process runner,
  diff-artifact-on-shelf, no-interrupt-on-failure. Strictest review.

### Phase C — stretch

- **B20 `phase-c/ts-morph-sequences`** — call-path sequence diagrams.

### Hardening

- **B21 `hardening/cross-cutting-sweep`** — foreground-priority
  throttle, snapshot LRU budget, `prefers-reduced-motion` full sweep,
  whole-suite litmus green, end-to-end headless QA of the entire
  voice+visual loop. Final gate before declaring the feature done.

## Phase-A headless QA result (2026-05-15) — HONEST STATUS

Ran the design-review agent against the live app. Outcome:

- **Theme consistency VALIDATED.** Ember/espresso palette holds
  across the app; nothing drifted to generic defaults. This confirms
  the in-theme bar for B1/B5/B8's surfaces.
- **Phase-A diagram overlays NOT visually verified.** The agent could
  not render an analyzed session (the live session was stuck
  "COMPOSING DIAGRAM" — a pre-existing backend/WS lag, NOT a B0–B8
  regression). So the heatmap overlay, concern tint, transition
  motion, and grill screen were not seen in situ. This is a recorded
  GAP, not a pass. Re-run required once a session renders (folded
  into B21, and a prerequisite: the composing-hang must be fixed
  first or all future visual QA is blocked).
- **Pre-existing UI debt surfaced (OUT of visual-companion scope,
  tracked separately):** mobile room navbar overflow @390px; the
  "COMPOSING DIAGRAM" infinite-hang with no timeout + swallowed WS
  error; lobby "Previously on" overlong; header git-SHA noise;
  narration line-length; missing focus-visible rings; near-invisible
  diagram edges; active-node double-amber. These predate this
  roadmap and are NOT silently absorbed into it — see the tracked
  task. The "fully polished product" goal means they must be fixed,
  but as their own effort, not by overclaiming a Phase-A pass.

## B21 hardening — completion status (2026-05-15, honest)

- **Pre-existing `briefing-composer` failure: FIXED** (not weakened).
  Root cause: `buildProjectOpener` blindly kept the first 2 sentences,
  dropping the dynamic "where the gravity is now" sentence — the
  catch-me-up payload. Fix: keep the first 2 (architectural shape)
  AND append a later dynamic "now" sentence if present (≤3, ~50 words
  ≪ the 30s interrupt threshold). Whole unit suite now **339/339
  green, 0 failures** (was 1 pre-existing red all session).
- **Cross-cutting items — honest split:**
  - LANDED + tested: `prefers-reduced-motion` (B2 motion + B8 grill),
    ELK node-count size guard (B11), sequence `clampChain` hairball
    guard (B20), the no-hallucination grounding guards (B12/B13), the
    enforced task permission ceiling (B19).
  - INTEGRATION-LAYER (recorded in VISUAL-COMPANION-PLAN Cross-cutting,
    NOT claimed done): foreground-voice-priority throttle, snapshot
    LRU eviction, off-thread shelf-write thread assertion. These need
    the live runtime wired (the per-branch cores they govern are
    landed + tested); they are explicitly deferred, not silently
    skipped.
- **Headless visual QA: still GATED** on the pre-existing
  "COMPOSING DIAGRAM" hang (task #73) — unchanged. Per-branch
  correctness gates (strict tests + typecheck + review) all passed;
  the integrated visual pass remains blocked until #73 is fixed.

## Tracking

Execution progress is tracked via the task list (created at kickoff).
This doc is the durable plan; the task list is the live state.

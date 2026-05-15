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

## Tracking

Execution progress is tracked via the task list (created at kickoff).
This doc is the durable plan; the task list is the live state.

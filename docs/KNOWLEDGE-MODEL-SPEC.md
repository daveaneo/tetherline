# Knowledge Model v2 — Two-Component Scoring, Layer vs Deep, Weak-Spot Review

Status: spec for implementation. Supersedes the v1 single-linear-ladder
scoring shipped in `cc08758` (it stays as the event substrate; the
*displayed* numbers are re-derived per this doc).

## 0. Why

v1 showed one global weighted average ("40% of 5") + a grilled count.
It conflated *being taught* with *proving it*, wasn't scoped to where
you are, and "explained?" was dead UI. v2 reframes knowledge as two
independent components, scoped to the current view, with a real grill
score and an actionable weak-spot loop.

## 1. The model (decided)

Every view has two parts: the **current layer** (the focused/titled
node, e.g. *Tetherline*) and its **components** (direct children: Core,
Voice, Shared, Frontend).

Knowledge of any node = **two components**:

1. **Listening / taught** (passive). Was the explanation delivered?
   The existing depth-lock already caps passive exposure at `heard`.
2. **Tested** (active recall), two tiers, each a 0–1 mastery ratio:
   - **regular quiz** — `correct / total` (objective)
   - **grill** — `strong / answered` (LLM-judged, fuzzier)

Plus the standalone **grilled** binary (passed the grill bar OR a
perfect quiz) — kept as the QA/supervisor proof.

`explained?` boolean is **removed** — replaced by an always-present
**▶ replay explanation** action (by the time a node is on screen it has
effectively always been delivered; the value is the *replay action*).

### DECISION 1 — RESOLVED: no verbal confirmation; presentation = taught
There is **no "got it" / verbal-confirmation mechanic at all**. The
listening component is earned automatically the moment a layer is
**presented on screen** (its briefing delivered, or it is navigated to
as the current layer). Exposure is assumed once shown; only the tested
component distinguishes real knowledge from mere exposure. This
**deletes** the confirmation-phrase comprehension path entirely
(`tryConfirmLastBriefing`, `CONFIRMATION_WINDOW_MS`, the
`confirmed_phrase` reason, and the integration test asserting "got it"
→ confirmed).

## 2. Scoring (the formulas)

Pure functions in `packages/shared/src/comprehension-model.ts`
(extends, not replaces, the shipped module). All constants are tunable
and named.

```
presented(n)     = the layer was shown on screen (briefing delivered
                   OR navigated to as current layer)
taught(n)        = presented(n) ? 1 : 0
regularRatio(n)  = quizTotal(n)  ? quizCorrect(n)  / quizTotal(n)  : 0
grillRatio(n)    = grillAsked(n) ? grillStrong(n)  / grillAsked(n) : 0
tested(n)        = max(regularRatio(n), grillRatio(n))      // best, monotonic
testedTier(n)    = grilled(n) ? 'grill'
                 : quizTotal(n) ? 'regular' : 'none'

LISTEN_W = 0.25   TEST_W = 0.75                              // RESOLVED
layer(n) = round(100 * (LISTEN_W * taught(n) + TEST_W * tested(n)))
```

Weights are 0.25 / 0.75 (not 0.40 / 0.60) **because presentation is now
auto-credited** — merely being shown the screen must not read as
"40% known". Shown-but-untested = 25 (real but weak signal); the bulk
is earned by proving it. So: untouched = 0 · shown-only = 25 · shown +
perfect quiz = 100 · shown + grill `solid` (0.8) = 85.

Implementation note: `presented` maps to the existing event "briefing
delivered → `heard`", so `taught(n) = levelOrdinal(level) >= 2 ? 1 : 0`
remains a correct proxy; the change is that nothing above `heard` is
set passively any more (no confirmation phrase), and quiz/grill write
the new ratio fields rather than inflating `level`.

**Roll-up (hierarchy from `contains` edges):**

```
combined(n) = isLeaf(n) ? layer(n)
                        : round(mean(layer(n), deep(n)))     // DECISION 2
deep(n)     = isLeaf(n) ? undefined
                        : round(mean over directChildren c of combined(c))
```

- A **component card's gradient fill = `combined(component)`** ("fill
  each component with a gradient that shows the deep knowledge level").
- The **current layer's deep-knowledge number = `deep(currentLayer)`**
  = mean of its components' `combined`.
- The **current layer's layer-knowledge number = `layer(currentLayer)`**.
- **Leaf**: no `deep`; its fill = `layer(leaf)` (its own knowledge).

### DECISION 2 (defaulted — confirm)
A non-leaf rolls into its parent as `mean(layer, deep)` — i.e. "how well
you know this module" and "how well you know what's inside it" count
equally. Override with a weight if depth should dominate.

`tested` is **monotonic** (best ever, never regresses) — consistent
with the existing never-demote rule. Staleness degrade still applies to
`taught` only.

## 3. Data model

`comprehension` table (extends the shipped `grilled` column; same
additive-migration idiom in `packages/backend/src/db/database.ts`):

| new column | type | meaning |
|---|---|---|
| `quiz_correct` | INTEGER DEFAULT 0 | last regular quiz score |
| `quiz_total` | INTEGER DEFAULT 0 | last regular quiz size (0 = never taken) |
| `grill_strong` | INTEGER DEFAULT 0 | last grill strong count |
| `grill_asked` | INTEGER DEFAULT 0 | last grill answered count (0 = never) |

`grilled` (boolean) stays. Set quiz_* in `manager.handleQuizAnswer`,
grill_* in `manager.handleGrillAnswer` completion — both sites already
compute these numbers; this just persists them (suggestion #2).

Weak spots — new table `weak_spots`:

```
(repo_path, item_id, question TEXT, source 'grill'|'quiz',
 created_at, resolved_at TEXT NULL)
```

`comprehension-log.ts` already extracts the first weak/partial question
(`weakSpot`). On grill/quiz completion, append each weak/partial
question as a row. A weak spot is **resolved** (a) explicitly by the
user in the review section, or (b) auto when the same item is later
grilled with no weak/partial. Resolved rows are hidden but retained
(audit), re-openable.

`ComprehensionItem` (shared type) gains: `quizCorrect`, `quizTotal`,
`grillStrong`, `grillAsked` (optional, back-compat). `applyComprehension`
overlays them onto diagram nodes alongside `level`/`grilled` (already
the read-time merge point in `routes/diagram.ts`).

## 4. UI

### 4a. Current layer (the title — full controls)

```
╔═ TETHERLINE ════════════════════════════════════════════════════╗
║ ▶ replay explanation                                             ║
║ Quiz  67%  ↻ retake          Grill  solid 4/5 ✓  ⚑ re-grill      ║
║ layer knowledge ▓▓▓▓▓▓▓░░░ 70%   deep knowledge ▓▓░░░░░░░░ 22%   ║
╚══════════════════════════════════════════════════════════════════╝
   ▸ Weak spots (2)   [review ▾]
```

- ▶ replay: re-emits the current node's explanation (reuse the existing
  briefing playback path).
- Quiz: `regularRatio` % + ↻ retake (re-run the quiz skill on this node).
- Grill: the comprehension-log **verdict word + ratio** (`solid 4/5`),
  the ✓ when `grilled`, ⚑ re-grill action. No false-precision %.
- layer / deep bars: §2 numbers. Bars (not dual-gradient) — precise,
  colour-blind safe.

### 4b. Components (simplified glance)

```
┌── Core ───────┐  ┌── Frontend ───┐  ┌── Shared ─────┐  ┌── Voice ──────┐
│▓▓▓▓▓▓▓░░░ 70%│  │▓▓▓▓░░░░░░ 40%│  │▓▓░░░░░░░░ 18%│  │░░░░░░░░░░  0%│
│ tested 67% �ⓖ │  │ tested  —    │  │ tested  —    │  │ untouched    │
└───────────────┘  └───────────────┘  └───────────────┘  └───────────────┘
```

- Fill = `combined(component)` (the gradient — its blended depth).
- One **tested** line: best ratio + a tier glyph (`ⓖ` = grill-passed,
  `ⓠ` = regular only, none = untested) — suggestion #3, one line not two.
- Click a component → it becomes the current layer (full 4a controls).
  Components stay simple because their controls appear when focused.

### 4c. Leaf nodes (bottom of a drill)

No `deep`. Fill = `layer(leaf)` (its own knowledge). Show only the
triad (replay / quiz / grill). Visually mark "leaf" (no roll-up) so a
flat fill doesn't read as "missing children data".

### 4d. Weak-spot review section

A collapsible panel on the current layer: lists open weak spots
(question + source + which item). Each row: **[restudy ▶]** (replays /
jumps to that item's explanation) and **[resolve ✓]** (marks resolved,
removes from the list; retained for audit). A "re-grill weak spots"
action runs a focused grill over just the open weak-spot questions.

## 5. Implementation plan (reuses shipped infra)

1. **Shared model** — extend `comprehension-model.ts`: add
   `taught/regularRatio/grillRatio/tested/testedTier/layerKnowledge`,
   and `rollUp(tree)` producing `{layer, deep, combined}` per node from
   `contains` edges. Replace `projectKnowledgeScore`'s single number
   with the layer/deep pair (keep old export as a thin shim if anything
   still calls it). Unit-test in `test/unit/comprehension-model.test.ts`.
2. **Data** — additive migration for the 4 columns + `weak_spots`
   table (`database.ts`); extend `comprehension-repo.ts`
   (Row/rowToItem/upsert + `recordQuiz`, `recordGrill`, `addWeakSpot`,
   `resolveWeakSpot`, `openWeakSpots`); set them at the existing
   quiz/grill completion sites in `session/manager.ts`. Extend
   `ComprehensionItem` + `applyComprehension`.
3. **DECISION 1** wiring — gate the `confirmed_phrase`→`confirmed`
   promotion per the chosen ruling.
4. **Diagram payload** — `diagram-extractor.ts` carries the new fields;
   `routes/diagram.ts` read-time overlay already merges live state.
5. **Render** — `HermesDiagram.tsx`: replace the v1 ladder/strip with
   §4a title block, §4b component cards (fill = combined, one tested
   line), §4c leaf handling. New `WeakSpotsPanel`. Retire the v1
   `KnowledgeStrip` ladder once the title block lands. Single source:
   colours stay `level-color.ts` / `--heat-*`; bars are `--heat`/`--ink`.
6. **Scenes + tests** — replace `comprehension-ladder` /
   `-legend-open` scenes with: `knowledge-layer` (focused title, all
   controls), `knowledge-components` (mixed component states + a leaf),
   `weak-spots-review`. Mirror in `scenes.spec.ts`; regenerate +
   visually re-verify baselines; `pnpm verify` green. Extend the
   integration test for quiz/grill persistence + weak-spot
   open/resolve.
7. **PDF** — regenerate `docs/POLISH-REVIEW.pdf` for re-eval.

## 6. Decisions — ALL RESOLVED

1. **Verbal confirmation** — REMOVED entirely. Presentation = taught;
   only quiz/grill earns knowledge. (§1 DECISION 1.)
2. **Non-leaf roll-up** — `mean(layer, deep)`, equal weight. Knowing a
   module and knowing its insides count the same.
3. **Weights** — `LISTEN_W 0.25 / TEST_W 0.75` (lowered from 0.40/0.60
   because presentation is auto-credited; reasoning in §2).
4. **Grill verdict** — reuse the shipped `solid ≥0.75 / shaky ≥0.4 /
   weak` from `comprehension-log.ts`. No divergence.

No open decisions remain — cleared for build per §5.

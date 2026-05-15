# Visual Companion — Implementation Plan

The diagram should stop being a static map and become Hermes's whiteboard:
one persistent canvas, many lenses, every transition narrated. "The
diagram is never *shown*, it's *talked through*."

## Core contract — three operations, only one "clears"

A skill that wants a visual picks ONE of these. This mapping is part of
the skill's job and **must be tested for correctness + polish** (see
Testing below).

| Operation | Behavior | Examples |
|---|---|---|
| **Layout/scope swap** | Clear + replace + snapshot to time-slider | drill into a module, generate a flow diagram, "deps of X" ego-graph |
| **Overlay lens** | Composite onto the *current* layout — never clears | comprehension heatmap recolor, karaoke pulse, touched-halos, frontier pulse |
| **Comparison** | Split-canvas, two layouts side by side | "old vs new", "core vs colab" |

- **No modals, ever.** Modals fight voice-first (demand "close that" /
  click). The **time-slider makes clear-and-replace non-lossy** — every
  layout swap is a rewindable turn-snapshot, so a modal's job
  (preserve-so-you-don't-lose-it) is redundant.
- **Trap:** the comprehension heatmap is an *overlay* (recolor of the
  current graph), NOT a layout swap. Conflating the two would blow away
  the diagram when the user asks "where am I weak?" instead of just
  tinting it. Keep the three categories strictly separate.

## Visualization mode dispatcher

The `visualize` skill (and possibly `explain`) routes the user's request
to a visual *mode*. Most modes need ZERO new tooling — they're
presentation modes over the cache we already warm.

| User intent | Mode | Operation | Build cost |
|---|---|---|---|
| "show me the data flow / pipeline" | sequenced reveal of cached logic-graph (source→transform→guard→sink) | layout swap + narration-synced reveal | **low — data exists** |
| "deps of X" / "what touches X" / "blast radius" | BFS ripple over cached module `imports` | layout swap | **low — pure traversal** |
| "where am I weak" / "what's left" | recolor radial by comprehension `level` | **overlay** | **~free — recolor** |
| "proper architecture diagram" | ELK-laid-out layered graph | layout swap | med — adopt ELK.js |
| "compare old vs new / A vs B" | side-by-side mini-graphs, deltas tinted | split-canvas | med — LLM diff call |
| "call path of `fn`" | function sequence diagram | layout swap | high — ts-morph/AST |

## Transition grammar (motion encodes navigational relationship)

The transition between current view and target view must tell the user
*what kind of move* this was, so the diagram becomes a navigable space,
not a slideshow. Relationship detection is **deterministic + cheap**
(navigator stack + `knownNodeIds`) — no LLM for routing; only GENERATE
needs an LLM call.

| Relationship | Detected when | Transition |
|---|---|---|
| **IN-PLACE** | `target == current scope` | No motion — overlay highlight/pulse only (the "explain what's displayed" case) |
| **DESCEND** | `target ∈ current node set` | Highlight the node, then it morphs/expands to fill the canvas (framer-motion `layoutId` shared-element) |
| **ASCEND** | `target ∈ navigator ancestors` | Current canvas shrinks back into a node in the parent view — the **exact inverse animation of DESCEND** (forward/backward of one motion → muscle memory) |
| **LATERAL** | `target` exists elsewhere, unrelated branch | Clean crossfade / slide — a cut. No spatial continuity exists; don't fake one |
| **GENERATE** | `target` has no node anywhere ("what is fine-tuning") | Diagram assembles/draws-in: title appears, 3-6 parts scale-in in sequence. LLM call: "major parts of `<concept>`", labeled nodes, minimal edges. Pairs with narration (diagram = skeleton, voice = flesh) |

- DESCEND/ASCEND are **one animation played forward/backward** — the
  single highest-value idea; turns the diagram into a space.
- **Time-slider replays inverse transitions:** scrubbing back plays the
  reverse of whatever got you there (rewinding a DESCEND looks like an
  ASCEND). Spatial language consistent in both directions.
- GENERATE is the cheapest slice of the Phase-B generative path and is
  what makes "always a visual" honest for pure-concept asks.

## `explain` decomposition (shared dispatcher)

`explain` always wants a visual. Two cases:
1. **Explain what's displayed** — overlay (narrate + karaoke-pulse on
   current layout). Trivial, zero visual work. → IN-PLACE transition.
2. **Explain what's NOT displayed** — establish the visual first via the
   dispatcher (layout swap), then narrate over it. → DESCEND / ASCEND /
   LATERAL / GENERATE depending on relationship.

The mode-dispatcher MUST be a **shared service**
(`intelligence/visual-dispatcher.ts`), not living inside the `visualize`
skill — otherwise skills call skills. `explain`/`teach`/`critique`/
`compare` all call it. Skill logic:

```
resolve target → is target in the current diagram's node set?
  yes → overlay (narrate + pulse)         [Case 1 / IN-PLACE]
  no  → dispatcher.renderFor(target)       [Case 2 / swap]
        then narrate over it
```

The "is it displayed?" membership test is half-built — lift
`isAnchorMatch` / `knownNodeIds` out of HermesDiagram into the shared
layer.

**Pure-concept fallback** (concept with no codebase footprint): prefer
GENERATE (tiny LLM "major parts" diagram). Secondary: highlight where
the concept manifests (reuse `teach` concept→code mapping). Last
resort: current map with loosely-related nodes pulsed.

## `compare` decision (decided — not split-canvas-by-default)

`compare` has THREE axes, extracted as a param `axis`:
- **structural** — "core vs colab" (two entities, same time)
- **temporal** — "what changed this week" / "how did X change"
  (needs git-range data we don't have yet)
- **vs-external** — "how's this differ from Django" (no second codebase
  entity — really `explain` with contrastive flavor)

Decisions:
1. **One skill, not renamed.** `axis` is a clean first-class param the
   LLM extracts reliably — NOT the overloaded-skill antipattern (the
   poem/summarize collision was format-vs-skill confusion; this isn't).
2. **`compare` delegates to the shared visual-dispatcher** (same as
   `explain` — skills never own visuals). Dispatcher maps axis → op:
   - structural → unified MERGED graph (layout swap). NOT split-canvas:
     side-by-side panels make the delta hard to see; a merged graph
     with analogous nodes aligned + provenance-tinted + deltas
     emphasized tracks differences far better (how git-diff / graph-
     diff tools actually work).
   - temporal → **overlay-diff** on the current layout (added=halo,
     removed=ghost, churned=pulse). Same layout, recolored — high wow,
     reuses the canvas. Gated on git-range extraction.
   - external → no second visual; verbal contrast on the single
     entity's view (route like `explain`).
3. **Split-canvas demoted to a fallback** only when a merged graph
   would be an unreadable hairball (size heuristic) or the user
   explicitly says "side by side." It is no longer the default.

Phasing:
- **v1 (now, zero new tooling):** `compare` = narrated sequential tour
  using EXISTING transitions — show A (DESCEND), narrate; LATERAL to B,
  narrate; synthesize the contrast verbally on B or back at parent.
  The spatial motion makes the comparison *felt*. Strictly better than
  today's prose-only-with-no-visual.
- **v2:** structural → unified merged graph (one LLM call aligns
  analogous nodes; reuses cached logic-graph).
- **v3:** temporal → overlay-diff (needs git-range extraction, Phase B+).

## `critique` decision (decided — overlay-only, voice-matched tint)

- **Operation: overlay, IN-PLACE.** Critiquing `core` tints the
  *current* view (worry=red, solid=green, the specific risk pulsed),
  never swaps layout. Critique is almost always about what's on screen.
- **Delegates to the shared dispatcher** with a "concern overlay" intent.
- **Decided (b): the critique LLM emits the node ids it's worried
  about as structured output; tint by THAT**, not the pre-computed
  concern layer. The visual must exactly match the spoken critique —
  a tint that contradicts the voice is worse than none. Cost: one
  structured `concernNodeIds` field on the critique skill output.
- v1 zero new tooling: recolor current map by the LLM-returned ids +
  karaoke-pulse each flagged node as it's named. Makes critique
  visually distinct (red/green) instead of prose-like-everything-else.

## `summarize` decision (decided — comprehension-heatmap overlay)

(Prompt/constraint/params-passthrough work already shipped & tested.
This is the visual decision only.)

- **project scope → comprehension-heatmap overlay, IN-PLACE.** Recolor
  the current radial map by comprehension `level` (cold=unknown →
  warm=confirmed) WHILE Hermes gives the verbal tldr. User hears what
  the project is + sees how much they actually grasp, one beat.
- **area scope** → IN-PLACE if displayed else DESCEND, then heatmap
  tint scoped to that subtree.
- **tiny-constraint summaries** ("in 5 words") → NO visual change; a
  one-liner quip isn't a teaching moment. Skip overlay when a
  word/line constraint < ~15 words is set.
- Cheapest visual in the plan: recolor mode, zero new tooling/data
  (`level` already on every node). Gives summarize a distinct visual
  identity no other skill has.

## Tooling decisions (from research, 2026)

- **KEEP custom:** SVG renderer, ember/espresso theming, radial layout
  (best for module-overview default), comprehension/heatmap overlays,
  karaoke pulses.
- **ADOPT ELK.js** as a layout *engine only* (not a renderer). Feed it
  our existing `{nodes,edges}`; it returns `(x,y)` coords we draw with
  our current SVG components. Unlocks layered/flow/dependency layouts the
  radial-only math can't do. Run in a web worker (bundle ~1.4MB).
- **ADOPT dependency-cruiser** server-side to ground "deps of X" / "data
  flow" in *real* imports — stops the LLM hallucinating edges. Pattern:
  extractor produces ground-truth graph → LLM selects/filters/labels a
  subgraph → ELK positions → our SVG renders.
- **LLM emits a Zod-validated JSON graph via tool-use**, never Mermaid
  text (LLMs reliably break Mermaid syntax). Extend the existing
  `DiagramPayload` type with a `layout: 'radial'|'flow'|'sequence'|'deps'`
  discriminator + an `intent` field the model fills *before* the graph
  (think-then-commit).
- **SKIP:** Mermaid, Graphviz/WASM, React Flow, Cytoscape — each imposes
  a foreign visual language or large bundle for capability ELK + our
  renderer already covers.
- **PHASE 2 only:** ts-morph for true call-sequence diagrams.

## Phasing

**Phase A — zero new tooling (presentation modes over existing cache):**
1. Comprehension heatmap (overlay, recolor radial by `level`) — ~free.
2. Pipeline walkthrough (layout swap; logic-graph already exists; add
   sequenced node-reveal synced to narration timing).
3. Blast-radius ripple (layout swap; BFS over cached `imports`).

**Phase B — generative visuals:**
4. Adopt ELK.js layout engine behind a non-radial path.
5. Adopt dependency-cruiser; make "deps of X" authoritative.
6. LLM diagram tool-use (Zod schema, `layout` discriminator).
7. Split-canvas for `compare`.

**Phase C — stretch:**
8. ts-morph call-path sequence diagrams.

## Testing requirements (MUST DO per skill)

For every skill that can produce a visual:

1. **Mapping correctness** — given a representative battery of user
   utterances, assert the skill picks the RIGHT visualization mode and
   the RIGHT operation (swap vs overlay vs split). Litmus-style script
   driven via the dev API + trace assertions.
2. **Polish** — the chosen visual must render cleanly: no overlap,
   readable labels, transitions are smooth (framer-motion, ~200ms),
   the karaoke pulse / narration timing actually lines up with the
   spoken words, the time-slider snapshot is correct.
3. **No-regression** — overlay lenses must NOT clear the current
   layout; comparison must NOT modal; clear-replace must always be
   rewindable via the slider.

Acceptance: a `test/litmus/visual-mapping.sh` (or equivalent) that
fails when an utterance maps to the wrong mode/operation, plus a
manual polish pass per phase.

**⚠️ Testing depth — this is non-negotiable.** Much of this feature is
emergent behavior (LLM routing + motion + timing) that ONLY surfaces
bugs under real exercise. Per phase, thoroughly test:

- **Mode mapping**: a wide utterance battery → assert correct visual
  mode AND transition relationship (IN-PLACE / DESCEND / ASCEND /
  LATERAL / GENERATE). Include adversarial / ambiguous phrasings.
- **Transition correctness**: DESCEND then ASCEND on the same node
  returns to the identical prior layout (inverse is exact). LATERAL
  never claims false continuity. GENERATE only fires when the target
  truly has no node.
- **Narration-sync**: karaoke pulses line up with the spoken node
  names within tolerance; the visual swap lands BEFORE the voice
  starts (the 200ms-pause contract).
- **Time-slider fidelity**: every layout swap snapshots; scrubbing
  back rehydrates the exact prior state and plays the inverse
  transition.
- **No-regression**: overlays never clear the layout; comparison never
  modals; clear-replace always rewindable.
- **Polish pass**: no node overlap, readable labels, smooth motion,
  no flicker on rapid successive asks.

Treat a phase as "not done" until its litmus passes AND a manual
exercise of the real voice+visual loop confirms it feels right.

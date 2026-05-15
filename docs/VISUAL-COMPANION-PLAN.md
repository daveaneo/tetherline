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

> **2026-05-15:** `explain` now also absorbs the one-shot `teach`
> (concept) case — it is rung 0–1 of the depth ladder. The prompt
> adapts concept↔node (dispatcher already detects which). "Go deep on
> a concept" is no longer `explain`/`teach` — it is the new `deep_dive`
> skill. See "Depth ladder, deep_dive & guided-learning mode".

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
   poem/whats_changed collision was format-vs-skill confusion; this isn't).
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

## `whats_changed` decision (decided — comprehension-heatmap overlay)

Renamed from `summarize` (user decision, 2026-05-15): the skill is
the on-demand "catch me up on what changed" recap, NOT generic
summarization — the user-initiated sibling of the auto briefing.
Prompt/description/classifier reframed accordingly.
(Prompt/constraint/params-passthrough work already shipped & tested.
This is the visual decision only.)

- **project scope → comprehension-heatmap overlay, IN-PLACE.** Recolor
  the current radial map by comprehension `level` (cold=unknown →
  warm=confirmed) WHILE Hermes gives the verbal recap. User hears what
  changed + sees how much they actually grasp, one beat.
- **area scope** → IN-PLACE if displayed else DESCEND, then heatmap
  tint scoped to that subtree.
- **tiny-constraint summaries** ("in 5 words") → NO visual change; a
  one-liner quip isn't a teaching moment. Skip overlay when a
  word/line constraint < ~15 words is set.
- Cheapest visual in the plan: recolor mode, zero new tooling/data
  (`level` already on every node). Gives whats_changed a distinct
  visual identity no other skill has.

## `navigate` decision (decided — canonical layout-swap, visual-only)

The ONLY skill where a layout swap is the primary intent, not a side
effect. Maps cleanly onto the transition grammar:
- "go to core" from project map → DESCEND
- "go to file X" → ALWAYS DESCEND. A file is by definition a deeper
  view; no IN-PLACE special-case even when the node is already
  visible on the current canvas. (User decision, 2026-05-15.)
- "go back to project" → ASCEND (inverse animation)
- "go to colab" inside core → LATERAL
- target not a node → NOT GenERATE; fail gracefully with fuzzy
  suggestion from knownNodeIds ("don't see an X — did you mean Y?").
  Never invent a diagram for a missing place.

Decisions:
- Delegates target resolution + relationship detection to the shared
  dispatcher (same as all skills).
- **Visual-only: minimal/no narration.** One-liner ack max ("Here's
  core."), then silence. The visual IS the response. Inverse emphasis
  of whats_changed (visual-primary vs verbal-primary).
- **No anchor pulse** — navigate isn't talking about anything, it's
  moving. Pulsing implies narration; keep navigate crisp.
- **Every navigate transition is a polished animated screen** — DESCEND,
  ASCEND, and LATERAL all animate; NO jarring instant cuts, including
  LATERAL (supersedes the earlier "clean cut" note). Navigate is the
  skill where the transition IS the product, so it must feel crafted.
  (User decision, 2026-05-15.)
- Least-broken skill today (drill-to-target was always correct here);
  mostly needs graceful-fail + transition-grammar wiring.

## `teach` decision (SUPERSEDED 2026-05-15 — see "Depth ladder & deep_dive")

> **Superseded.** `teach` no longer exists as a standalone skill. The
> one-shot concept case **merges into `explain`** (rung 0–1 of the depth
> ladder); the "go deep on a concept" case becomes the new **`deep_dive`**
> skill. The GENERATE machinery described below is **retained** — it is
> now owned by the `deep_dive` pocket canvas (how an unrelated-topic
> pocket gets its visual), not a standalone teach skill. Read the
> "Depth ladder, deep_dive & guided-learning mode" section first; the
> GENERATE notes here are still the reference for that mechanism.

`teach` is almost always about a CONCEPT (no single node) — the
canonical pure-concept case the GENERATE transition was designed for.

- **Operation: layout swap via GENERATE.** LLM call: "3-6 major parts
  of `<concept>`" → `{title, parts:[{label, implementedBy?}]}`. Diagram
  assembles/draws-in while Hermes teaches (skeleton + voice).
- **Grounding (key):** reuse teach's existing concept→code mapping
  (`understandingUpdates`). GENERATE nodes link to the real modules
  that implement the concept where possible — each part can DESCEND
  into actual code. "teach me X" → "show me where X is" is a one-
  gesture follow-up. Not abstract art.
- **Concept that IS a code entity** ("teach me the diagram-extractor")
  → dispatcher relationship detection routes it DESCEND/IN-PLACE like
  explain; no special-casing in teach.
- Generated diagram is **cached + time-slider-revisitable** like any
  layout snapshot. No special handling.
- v1 cost: one structured LLM call, cacheable on (concept, repo HEAD).
  Highest-value GENERATE use — teaching needs a scaffold, concepts
  have no pre-existing node.

## Depth ladder, deep_dive & guided-learning mode (decided 2026-05-15)

Origin: a jam on "is `explain` vs `teach` even two skills." An
empirical test (same params fired at each via the new
`/api/dev/skill` force-skill endpoint) showed the prose-stance
difference is real but too soft to be decision-relevant for the
common case (a dev who already knows the concept). Conclusion: the
right axis is **not skill-type, it's depth on one topic**.

### The depth ladder (replaces leaf-vs-orchestrator framing)

One topic, served at whatever depth the user reaches for:

- **Rung 0** — quick answer (a few sentences).
- **Rung 1** — fuller / side explanation.
- **Rung 2** — `deep_dive`: a gated ≤10-slide presentation.

Rungs 0–1 are **one merged skill** (`explain`, with `teach` folded
in — the dispatcher already detects concept-vs-node, so the prompt
adapts). `teach` is removed as a standalone skill. The user *climbs*
the ladder via an explicit affordance; you never silently land in a
deep dive.

### `deep_dive` — an orchestrator skill, not a leaf

- **Shape:** scoping handshake → ≤10-slide presentation (aim 10, can
  be fewer; PowerPoint metaphor, slides numbered "1/10").
- **Composes leaf skills:** each slide's spoken words + visual are
  produced by existing skills (explain/visualize/compare). deep_dive
  *conducts*; it does not generate content itself.
- **Topic can be ANYTHING** — including subjects with no node in this
  repo ("deep dive on Rust async"). This is the decisive constraint;
  it forces the visual-sandbox property below.

### Scoping handshake = intent gate + outline pass (one mechanism)

ChatGPT-deep-research style: user triggers (button or "deep dive") →
AI asks 1–2 clarifying questions → user confirms → it commits. This
single handshake does **two jobs at once**: it is the deliberate-
intent friction (deep_dive is expensive — ~12 LLM calls) AND the
outline-planning pass (the answers scope the ≤10-slide structure).
Not two separate steps.

### Pocket dimension — a first-class container

A deep_dive lives in nav as a **pocket dimension**: an explicit,
named, bounded (≤10-beat), unit-skippable, **persistent + resumable**
sub-space. It is the matured form of the existing `TourPlan`
deviation stack (`pushDeviation`/`popDeviation`/`isInDeviation`),
which today is implicit and transient.

A pocket is three things at once:

1. **Nav cursor** — its own internal 1→N slide index, independent of
   the outer spine position.
2. **Visual sandbox** — because the topic may be unrelated to the
   repo, the pocket cannot borrow the repo diagram. Entering
   **snapshots** the main canvas; the pocket gets its **own GENERATEd
   canvas**; exiting **restores the outer canvas exactly**. This is
   not new machinery — it is the snapshot + time-slider + GENERATE
   pieces already in this plan, now with a first-class reason to
   exist. GENERATE (ex-`teach` flagship) is owned here.
3. **LLM budget** — the plan is cacheable on `(topic, repo HEAD)`;
   each slide on `(skill, params, repo HEAD)`. Affordable *only*
   because the content-addressable cache already exists.

### Subway model — how linear traversal and branching coexist

The resolution to the "linear tour vs deep-dives section" tension:

- The **guided tour is the spine** — purely linear; it only ever
  walks the spine.
- Each **deep_dive is a station you exit into** — on the spine it is
  a single **atomic** stop. Outer "skip" passes the station; it
  **never steps through its 10 slides**.
- Inside the station: a **PowerPoint** (≤10 slides, own back/forward,
  "1/10").
- The **"deep-dives" section in nav is the station index** — a
  fast-travel/bookmark menu of opened pockets, each remembering its
  own slide cursor ("continue each/all" is free). It is NOT a
  parallel traversal model — a bookmark layer over pockets.

Net: the spine never branches; branching lives *inside* pockets.

### In-pocket question behavior (all three, gated)

When the user asks a question mid-pocket (e.g. slide 4/10):

- **Stay & discuss** — default; transient, returns to slide 4.
- **Side explanation** — transient, returns to slide 4.
- **Nested deep_dive** — allowed, but requires the *same scoping
  handshake*. Gated recursion: you can go deeper, never *accidentally*
  fall down nested pockets. Never silent.

All states are resumable (each pocket persists its cursor; the spine
persists its position).

### Guided-learning mode — ~70% already built

NOT a new modality. It is today's `full_walkthrough` entry mode +
`TourPlan` (which already handles barge-in: utterance pushes a
deviation, `resume_tour` pops it) + existing auto-advance
(`manager.ts:1930`). Missing, specifically:

1. **~5s inter-beat pause + lean-back/movie framing** (today it
   advances the instant narration ends — no breathing room).
2. **Architecture spine**: today the tour walks recent-change areas
   (`TourPlan.fromAreas`); guided-learning walks the architecture
   **top-down**. **RESOLVED 2026-05-15 — COEXIST, not replace.**
   - The change-walk is the franchise (weekly review = the product's
     north star); replacing it would gut core value. The
     architecture-walk answers a *different* question ("how is this
     built?" — onboarding / returning / understanding vs. tracking
     the delta). Two questions → two walks; killing either to avoid
     having two is the wrong trade.
   - Never auto-arbitrated. Selected by **explicit user intent** via
     the existing `EntryMode` fork: `updates` → change-spine (opened
     by the auto-briefing, owned with `whats_changed`);
     `onboarding`/`full_walkthrough` → architecture-spine (opened by
     guided-learning mode); `explore` → no spine. Plus an explicit
     in-session command to switch spines. The system never guesses.
   - Cheap because it is **one engine, two spine *builders***:
     `TourPlan.fromAreas(changeAreas)` vs. a new
     `TourPlan.fromArchitecture(navigatorTopDown)`. A second factory
     method, not a second implementation. Cost ≈ one function + one
     sentence of entry-point framing.

`deep_dive` and guided-mode are the **same engine at two scopes**:
one subject (deep_dive) vs the whole architecture top-down
(guided-mode). This is why the modality "is a skill under the hood."

### Open UX problems (flagged, not yet solved)

- "Where am I" rendering across spine + open pockets.
- The station-index UI and the enter/exit pocket transition.
- (Spine collision — RESOLVED above: coexist via EntryMode fork.)

### Phasing for this block

- **Pre-work / cheap, do early:** the `explain`+`teach` **merge**
  (skill consolidation + prompt that adapts concept↔node). Removes a
  classifier boundary; no new tooling.
- **Phase B:** `deep_dive` orchestrator (scoping handshake, slide
  composition, pocket container, visual sandbox via GENERATE).
- **Phase B/C:** guided-learning mode (inter-beat pacing is cheap;
  the architecture-spine re-point is the real work).

### Testing requirements specific to this block

- Handshake **actually gates**: a bare "deep dive" without
  confirmation must NOT launch a presentation.
- Skip is **atomic**: outer skip over a pocket never emits its inner
  slides.
- Resume **fidelity**: re-entering a pocket from the station index
  restores the exact slide cursor; exiting restores the outer canvas
  pixel-for-pixel (snapshot fidelity — same assertion as time-slider).
- Nested dive only via handshake (no silent recursion path exists).
- Cache: identical `(topic, repo HEAD)` reuses the plan; no second
  outline LLM call.

## Remaining skills (decided)

- **annotate** — **UPGRADED 2026-05-15 to full version (not deferred).**
  overlay, IN-PLACE, persistent pin glyph on the flagged node (distinct
  from auto touched-halo: explicit/user-asserted, DB-persisted).
  One-liner ack. **Recall is now v1, not a follow-up:** annotations
  live in a first-class **Notebook** surface (see "Non-blocking review
  shelf" below); on session start, existing pins render on load and
  Hermes mentions the count in one sentence. "show me what I flagged"
  → dim-all-except-pinned lens is part of the full version.
- **create_issue → renamed `track_issue` (decided 2026-05-15),
  placeholder.** See "Outbound & async skills" below — becomes the
  multi-tracker follow-up flag (Jira/Linear/GitHub); GitHub-only draft
  today is the placeholder. Code rename deferred until the
  multi-tracker buildout (renaming a placeholder now = pure churn).
- **share_explanation → ABSORBED into `export`.** It is just "export
  the current area as markdown" — a degenerate case of the general
  export skill. Removed as a standalone skill. See below.
- **grill_me** — **REVISED 2026-05-15 (supersedes the live level-up
  halo proposal).** Operation: **layout-swap to a dedicated quiz
  screen** — snapshot the current canvas, show a single calm,
  SVG-animated **`?` glyph** for the duration of the grill, restore
  the prior canvas on exit (lightweight sandbox; same snapshot +
  time-slider machinery as a pocket, but NO GENERATE — the screen is
  a static animated glyph).
  - Rationale: grilling is an auditory/conversational experience; the
    screen is a *mode indicator*, not a cleverness contest. The
    content is carried by voice + text, not the visual. Rejected the
    halo animation as over-built for this skill.
  - The grill Q/A text **must ride the existing HermesText surface**
    so it is both heard AND read (questions are generated in the
    manager via `grill.ts` — they must flow through the normal
    narration path, not be diagram-only).
  - **RESOLVED 2026-05-15 — lands on the shelf.** A finished grill
    drops a **comprehension log** entry (e.g. "auth: heard→explained,
    weak spot: token refresh") into the review shelf as its third
    artifact type, alongside notes (Notebook) and tasks (task tray).
    It also feeds the heatmap over time. Rationale: the delta is
    already computed (data wired this session), the shelf is a typed
    extensible surface by design, and this turns `grill_me` from a
    throwaway quiz into a longitudinal understanding record.
- **none (escape hatch)** — creative (poem/joke) → NO visual. Code-ish
  unmatched question → handleQuestion path already karaoke-pulses
  referenced nodes on the current view. So: pulse-only, no swap, no
  generate. Consistent with "creative ≠ visual".

## Non-blocking review shelf + outbound & async skills (decided 2026-05-15)

### The unifying pattern: a non-blocking review shelf

Three features the user described — the **Notebook** (annotations),
the **deep-dives station index**, and the **task tray** (below) — are
the *same UX primitive*: a **persistent, non-blocking side surface
where asynchronously-produced artifacts accumulate and can be reviewed
without breaking conversational flow.**

This is bound by the product north star: voice conversation must stay
concise, relevant, prompt, **uninterrupted**. Therefore anything that
"reports back" (a finished annotation set, a completed deep-dive, a
finished agent task) must NOT barge into the conversation. The
contract: **artifact lands on its shelf + a quiet notification; the
user pulls it when ready.** Never push-interrupt.

Build these as one shelf component with typed sections (notes /
deep-dives / tasks / comprehension logs), not bespoke panels. The
deep-dives station
index from the depth-ladder section is the first instance; Notebook
and task tray are siblings.

### `annotate` full version

- Create → DB-persisted note + pin glyph on the node (already wired).
- **Notebook**: the shelf section where all annotations for this repo
  live; reviewable across sessions; entries link back to their node
  (click → DESCEND to it).
- Recall lens: "show me what I flagged" → dim-all-except-pinned.
- Session-start: render existing pins; Hermes one-liner with count.

### `export` (consolidated superset — absorbs `share_explanation`)

One skill. **Formats:** video, PDF, markdown, HTML website, slides
(existing reveal.js path). **Scope:** the whole project *as mapped by
initialization* (the navigator/architecture model), OR a named
subsection. `share_explanation` ("current area as markdown") is just
the smallest scope×format cell — it folds in, not a separate skill.
Fronts the existing `export.ts` route; extends it with video/PDF/site
generators. NO visual beat (it's an artifact action) — but the
produced artifact appears on the shelf.

### `create_issue` → `track_issue`; multi-tracker placeholder

Renamed **`track_issue`** (decided 2026-05-15). Rationale: the
universal cross-tool noun for Jira/Linear/GitHub/GitLab is literally
"issue" (only Azure DevOps differs — "work items"); the GitHub-feel
came from the skill's *description + GitHub-only impl*, not the word
"issue". "Support ticket" was rejected — that names the *helpdesk*
category (Zendesk/ServiceNow), not dev issue trackers. `track_issue`
pairs the category word (tracker) with the universal item noun, so
it's self-documenting and tool-agnostic.

**Placeholder now:** drafts only (GitHub-flavored today). **Roadmap:**
write to Jira / Linear / GitHub. Code rename deferred until that
buildout (placeholder rename = pure churn; unlike
`summarize`→`whats_changed`, no behavior changes yet). Tighten the
`description` to "File a follow-up issue to the configured tracker"
when built. NO visual beat; result → shelf.

### `task` (NEW skill — async agent dispatch)

Fire off an AI agent to do a task, report back **without interrupting
the conversation**.

- Dispatch is fire-and-forget; the voice session continues
  immediately and uninterrupted.
- Completion → a **quiet notification** + an entry in the **task tray**
  (the third shelf section). User reviews on their own time.
- This is the canonical test of the no-interrupt contract: a
  long-running agent MUST NOT speak over Hermes or yank the visual.
- v1 scope is deliberately open — placeholder-grade like
  `create_issue`; the *non-blocking report-back plumbing* is the part
  that must be designed correctly from the start (it is shared shelf
  infrastructure, not task-specific).

### Skill roster after this block

Leaf/outbound: visualize, explain (absorbs one-shot teach), compare,
critique, whats_changed, navigate, annotate, export (absorbs
share_explanation), track_issue (was create_issue; code rename
deferred), task (new), grill_me, none. Orchestrators: deep_dive,
guided-learning mode.

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

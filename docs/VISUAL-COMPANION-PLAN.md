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

**Flow (decided 2026-05-15):**

1. **Explicit trigger** — a **deep-dive button** OR the spoken phrase
   "deep dive". NOT implicit escalation; Rung 2 is never entered by
   accident. (The lower rung is separate and untouched: "tell me more
   / go deeper" → existing `dive_deeper`, Rung 0→1.)
2. **Exactly ONE question** — *"Please tell me what to focus on in
   the deep dive."* (Supersedes the earlier "1–2 questions." One
   question still does **both jobs**: deliberate-intent friction —
   deep_dive is expensive, ~12 LLM calls — AND the outline-scoping
   pass. Not two steps.)
3. **Cancel** — a button OR a spoken option ("cancel" / "never
   mind"). Must work BOTH at the question AND during the loading
   screen — cancelling mid-compose aborts the in-flight LLM fan-out
   (ties to foreground-priority: a changed mind must not burn ~12
   calls).
4. Unless cancelled → **run, behind a loading screen.** The loading
   screen IS the pocket-enter moment — its visual is designed with
   the pocket enter/exit transition (see Open UX problems), not
   separately. On GENERATE failure it degrades to the text-skeleton
   fallback (Cross-cutting: robustness) — never a blank wait.

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

### Station-index UI (decided 2026-05-15 — delegated, jammed)

Iterated against every prior boundary; landed here:

- **It is the "deep-dives" section of the unified shelf — a flat
  list, deliberately NOT a spatial mini-map.** A map was considered
  and rejected: it violates "one shelf component, typed sections, not
  bespoke panels" and the minimalism boundary. The index is a *phone
  book, not a map* — spatial richness lives INSIDE the pocket (the
  PowerPoint); the index only needs to get you back in.
- **Each row:** focus-title (what the user said at the scoping
  question) + progress pill (`4/8` · `done` · `failed`). Order =
  most-recent-first. No manual reorder/edit/delete (same read-only-
  register boundary as `track_issue`/task tray). Dismissal = LRU
  auto-evict (the SAME lever as the snapshot-budget scale req — one
  mechanism, not two).
- **Re-entry is NARRATED, not a cold cursor-restore.** Select row (or
  "go back to the X deep dive") → plays the pocket-enter transition +
  Hermes gives ONE sentence: *"Back in the X deep dive — slide 4 of
  8, we'd just covered Y."* Honors the "every transition narrated"
  core contract; bare drop-onto-slide-4 is disorienting after a long
  gap. Cheap (recap = prior slide's topic).
- **"You are here" coupling — REFINED.** The index *reflects* the
  active pocket but is NOT the primary position surface: a lean-back
  user not looking at the shelf would be blind. The P0 fix is a
  separate **persistent breadcrumb** (`spine ▸ "X" ▸ 4/8`) always
  visible; the index mirrors it. Distinct responsibilities, designed
  together.
- **Empty state teaches** (non-naggy, only when empty): "No deep
  dives yet — say 'deep dive' or tap the button."
- **Do NOT reuse the time-slider / history-rail for pockets.** A
  pocket is a sub-space, not a conversation turn; conflating "rewind
  the conversation" with "re-enter a detour" mixes two mental models
  (same reasoning as the grill snapshot-vs-tick clarification).

### Pocket enter/exit transition (decided 2026-05-15)

This is the **visual transition screen/motion** for crossing into a
pocket and back. (Subsumes the deep_dive loading screen — same
moment.)

- **Mechanic — submerge / resurface = sealed-space DESCEND/ASCEND.**
  Reuses the transition grammar: the spine canvas snapshots and
  *parks/dims behind* (preserved, NOT destroyed — the motion must say
  "waiting for you"), pocket surface comes forward. Exit is the exact
  inverse (resurface to the **pixel-exact** prior spine state —
  snapshot-fidelity req), with the one narrated re-entry/return
  sentence (see Station-index UI). Same forward/backward muscle
  memory as DESCEND/ASCEND.
- **Loading = the skeleton constructing itself, not a spinner.**
  Title + slide-rail scaffold appear immediately; slides fill in as
  each composes (parallel fan-out). The wait is shown as
  *construction*. GENERATE-fail → text-skeleton fallback (never
  blank). Cancel available throughout (aborts in-flight fan-out).
- **Theme consistency (user decision):** rendered ENTIRELY in the
  existing ember/espresso design system — the same oklch ink/cream/
  amber tokens, serif+mono type, and the ~150–200ms eased motion +
  subtle blur/glow used elsewhere. No foreign spinner, no library-
  default aesthetic, no new visual vocabulary. The mechanic is
  in-grammar; the skin is in-system.
- **`prefers-reduced-motion`:** submerge/resurface degrade to a
  labeled instant cut ("⤓ deep dive: X" / "⤒ back to tour") using
  the same tokens — the boundary still reads without motion.

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

### Open UX problems

- **"Where am I" — PROMOTED to a P0 ship-blocker** (see Cross-cutting:
  UX). No longer a footnote: the subway model is not shippable until
  the spine+pocket+slide indicator exists.
- Station-index UI — RESOLVED 2026-05-15 (see "Station-index UI").
- Enter/exit pocket transition — RESOLVED 2026-05-15 (see "Pocket
  enter/exit transition"): submerge/resurface in-grammar, skinned
  in-theme, loading = self-constructing skeleton.
- All "Open UX problems" are now resolved. The only remaining P0 is
  the persistent "you are here" breadcrumb (Cross-cutting: UX) — a
  build task, no longer an open design question.
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
  a static animated glyph). NB: grill uses the *snapshot/restore* half
  of that machinery, NOT the time-slider-tick half — a quiz is a mode,
  not a rewindable turn; it must not appear as a scrubber tick.
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
deep-dives / tasks / issues / comprehension logs), not bespoke panels.
The deep-dives station index from the depth-ladder section is the
first instance; Notebook and task tray are siblings.

**Voice-first access (decided — audit 2026-05-15):** the shelf is a
click surface in a lean-back/voice product, so it MUST have a spoken
door. "what's on my shelf" / "read me my notes" / "any tasks done"
→ Hermes speaks a one-line digest per section and the shelf opens.
The shelf is never *only* reachable by mouse. (See Cross-cutting.)

### `annotate` full version

- Create → DB-persisted note + pin glyph on the node (already wired).
- **Notebook**: the shelf section where all annotations for this repo
  live; reviewable across sessions; entries link back to their node
  (click → DESCEND to it).
- Recall lens: "show me what I flagged" → dim-all-except-pinned.
- Session-start: render existing pins; Hermes one-liner with count.

### `export` (consolidated superset — absorbs `share_explanation`)

One skill. `share_explanation` ("current area as markdown") is just
the smallest scope×format cell — it folds in, not a separate skill.
NO visual beat (it's an artifact action) — but the produced artifact
appears on the shelf.

**Architecture (decided 2026-05-15): one export model, N renderers.**
We already produce, per area, an **SVG** visual + a summary + file
list. Serialize that into one ordered intermediate model
(`[{title, svg, prose, files}]`); renderers consume it:

- **markdown** — exists (`markdown-generator.ts`).
- **slides** — exists (reveal.js `generateRevealSlides`).
- **site** — NEW. HTML site ≠ slides: slides are a presenter deck
  (one-per-screen), a site is navigable multi-page (sidebar/sections).
  Same content, new *shell/template* — cheap but not "just a script".
- **pdf** — NOT independent. HTML→PDF via print stylesheet / headless-
  chrome print; a post-step on the site/print render.
- **video** — **honest stub now.** A known format that throws a clean
  `NotImplementedError` (fail honestly, never pretend/hang). Must be
  stubbed **async-shaped**: when the real video library lands it is a
  long-running render → a `task` (lands on the shelf), NOT synchronous.
  Stubbing it async-shaped avoids a later rewrite.

**Scope** (whole project *as mapped by initialization* vs a named
subsection) is solved upstream: it just decides *which sections enter
the model*. Every renderer is scope-agnostic for free.

Cheap because visuals are **SVG** — embeds/prints crisply into
HTML/PDF. The "keep custom SVG renderer" tooling decision pays off
directly here. Fronts/extends the existing `export.ts` route.

**OPEN (deferred to build time):** whole-project export defaults to
the architecture spine or the change spine? (Spine-collision applies —
"the system" vs "this week" are different documents.) Decide at
build, likely a choice at export time.

### `create_issue` → `track_issue`; multi-tracker placeholder

Renamed **`track_issue`** (decided 2026-05-15). Rationale: the
universal cross-tool noun for Jira/Linear/GitHub/GitLab is literally
"issue" (only Azure DevOps differs — "work items"); the GitHub-feel
came from the skill's *description + GitHub-only impl*, not the word
"issue". "Support ticket" was rejected — that names the *helpdesk*
category (Zendesk/ServiceNow), not dev issue trackers. `track_issue`
pairs the category word (tracker) with the universal item noun, so
it's self-documenting and tool-agnostic.

**Product boundary (decided 2026-05-15): a review tool, NOT an issue
manager.** `track_issue`'s entire job is *frictionless capture in the
flow of reviewing* + a **glanceable read-only register** (which
issues, what state). Deliberately dumb: NO triage, edit, status
changes, comments, or management UI. This boundary exists to prevent
scope creep into a mini-Jira.

- **Surface:** the "issues" section of the review shelf (sibling to
  the Notebook / task tray) — a minimal list of tracked issues + each
  one's current state. Display only.
- **Placeholder behavior:** create + persist + list **locally** with
  state. Useful with zero integrations (a local follow-up register).
  External sync becomes a later "flush to tracker" step, not a
  rewrite.
- **Promotion / management:** OUT of scope (annotate↔track_issue
  promotion, editing, triage). Annotate = private Notebook note;
  `track_issue` = an actionable item bound for the team tracker. They
  stay distinct shelf sections.
- **Roadmap:** write to Jira / Linear / GitHub via a tracker-adapter
  seam (`IssueTracker` interface; skill stays tracker-agnostic). This
  is a build-time detail, NOT a design priority — the priority is the
  low-friction capture path + the glanceable list.
- Code rename deferred until that buildout (placeholder rename = pure
  churn; unlike `summarize`→`whats_changed`, no behavior change yet).
  Tighten `description` to "File a follow-up to the configured
  tracker" when built. NO visual beat; result → shelf.

### `task` (NEW skill — async agent dispatch)

Fire off an AI agent to do a task, report back **without interrupting
the conversation**.

- Dispatch is fire-and-forget; the voice session continues
  immediately and uninterrupted.
- Completion → a **quiet notification** + an entry in the **task tray**
  (the third shelf section). User reviews on their own time.
- This is the canonical test of the no-interrupt contract: a
  long-running agent MUST NOT speak over Hermes or yank the visual.
  Failures ALSO just land on the shelf (error state) — never
  interrupt. The shelf is the only channel; the conversation is never
  preempted, at any tier.

**Capability gated by a permission setting; default read-only
(decided 2026-05-15).** The setting is a *ceiling*. Ladder:

- **`read_only` (default)** — investigates; produces a report
  artifact. Touches nothing (no fs/repo/network mutation).
- **`draft`** — may compute changes; emits a **reviewable diff as a
  shelf artifact**. Applies nothing.
- **`write`** — may apply, but only on a **dedicated branch/worktree**
  (never the working tree directly — always reversible), and crossing
  into apply still drops a non-blocking confirm on the shelf rather
  than auto-applying, unless explicitly set to full-auto.

Design thesis: even the "rewrite my code" case, by default, becomes
"agent proposes a diff, you review it" — Tetherline's own thesis
(review before absorbing) applied to its own automation. Full power;
danger is opt-in and branch-sandboxed. Permission lives in settings
(global ceiling, not per-dispatch).

- **Substrate v1:** in-process async LLM runner with a bounded step
  budget, results→shelf. External-agent substrate (Claude Code/SDK)
  is a later swap behind the same dispatch interface.
- **Lifecycle:** reuse the `track_issue` boundary — the task tray is a
  glanceable read-only register, NOT a job manager. Fire → runs to
  completion/failure → shelf. No cancel UI in v1.
- v1 scope deliberately placeholder-grade; the *non-blocking
  report-back plumbing* + the *permission ceiling* are the parts that
  must be correct from the start (shared shelf + safety infra, not
  task-specific).

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

## Cross-cutting requirements (audit 2026-05-15): robustness · UX · scale

Per-feature decisions above are sound; these are the gaps an audit
found. Each is a hard requirement unless marked OPEN.

### Robustness

- **`task` permission ceiling is ENFORCED, not just defaulted.** A
  `read_only` ceiling must actively *reject* a write/draft attempt and
  land the rejection on the shelf — never silently downgrade or
  proceed. Write-tier work happens on a dedicated branch/worktree,
  never the working tree. This is the riskiest surface in the plan;
  it gets the strictest tests (see Testing).
- **Every generative visual has a degraded mode.** GENERATE failure or
  cold/slow cache must not yield an empty pocket/canvas. Fallback
  chain (same spirit as explain's): GENERATE → text-skeleton card
  (the outline labels as a static list-diagram) → prior canvas with a
  spoken "couldn't draw that, here's the gist". A pocket is NEVER
  visually empty.
- **deep_dive bounds are enforced server-side:** clamp the outline to
  ≤10 beats regardless of what the LLM returns; a barge-in while a
  slide is still composing cancels that compose and answers the
  question (no half-rendered slide shown).
- **Shelf writes are off the conversation thread.** Artifact
  persistence must never block narration/dispatch. The no-interrupt
  contract is a *threading* requirement, not just a UX one.

### UX

- **"Quiet notification" — defined.** It is exactly: (1) a silent
  shelf-section badge increment, plus (2) at most ONE short spoken
  line, deferred to the next natural narration pause, never
  mid-sentence, never stacking (coalesce if several land). No sound
  effects, no modal, no visual yank. This single definition governs
  every "reports back" in this plan.
- **"You are here" is a P0, not a footnote.** The subway/pocket model
  is unusable without a persistent indicator: spine position + which
  pocket (if any) + slide n/N. Promoted out of "open problems" — the
  subway model is not shippable until this exists.
- **`prefers-reduced-motion` degrades the transition grammar** to
  instant-but-*labeled* (a one-word "↓ core" / "↑ project" caption
  replaces the morph). The relationship must still be legible without
  motion.
- **Depth-ladder affordance — RESOLVED 2026-05-15.** Explicit
  trigger: deep-dive button OR spoken "deep dive" → one scoping
  question → cancel (button/spoken, valid through loading) → run.
  See "Scoping handshake" for the full flow. Lean-in discoverability
  = the visible button; the lower rung (`dive_deeper`) is unchanged.

### Scale

- **Foreground voice has absolute priority.** Background tasks/deep_dive
  composition share the LLM client + rate limit with the live loop;
  they MUST be queued/throttled behind foreground turns. A background
  audit must never slow a spoken reply (direct north-star risk).
- **deep_dive slides compose in parallel** post-outline (independent
  beats fan out), not 12 serial calls. Cold-cache latency is the gate.
- **Snapshot budget.** Layout-swap + pocket snapshots are evicted
  LRU beyond N (serialize older ones); SVG snapshots are heavy and
  currently unbounded across a long session.
- **Size guards on heavy tooling.** ELK layout and dependency-cruiser
  both degrade on large repos: enforce a node-count/timeout heuristic
  (same spirit as the split-canvas hairball guard) and cache
  dependency-cruiser output keyed on repo HEAD like every other
  extractor.

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

**Async / shelf / task surface (the visual battery does NOT cover
this — added audit 2026-05-15):**

- **task permission ceiling**: a `read_only` ceiling MUST reject a
  write attempt (assert rejection + shelf entry; assert working tree
  unmodified; assert any writes confined to the sandbox branch).
- **no-interrupt under load**: with a background task running, assert
  foreground narration latency is unaffected and the task NEVER emits
  a spoken line except as the defined quiet-notification at a pause.
  Failure of a task also must not interrupt.
- **shelf non-blocking**: a deliberately slow artifact write must not
  delay the next dispatch/narration (thread assertion, not just UX).
- **export**: `video` returns the honest `NotImplementedError`
  (surfaced, not swallowed); a subsection scope actually filters the
  export model; markdown/slides parity with the pre-consolidation
  output (no regression from absorbing `share_explanation`).
- **degraded visuals**: force a GENERATE failure → assert the
  text-skeleton fallback renders and the pocket is never empty.

Treat a phase as "not done" until its litmus passes AND a manual
exercise of the real voice+visual loop confirms it feels right.
**No feature in this plan is "done" while its Cross-cutting
requirements are unmet — robustness/scale gaps are not polish, they
are correctness.**

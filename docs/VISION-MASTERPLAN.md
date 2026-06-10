# Tetherline — Vision Masterplan

**Goal.** Close the gap between a developer and a codebase that AI is writing faster than they can absorb. Tetherline should feel like talking to a human who always has the right presentation ready — starts high, follows you down, remembers where you've been, and knows what you already understand. Every question gets a quick voice answer, ideally paired with a visual aid; the whole experience should feel **fun, interactive, and intuitive** — not a documentation crawl, not a search box.

This is the *product* masterplan. [`TESTING-MASTERPLAN.md`](./TESTING-MASTERPLAN.md) covers the dev-API + test infrastructure that underpins it.

## 1. The vision, in three mechanics

### 1.1 The Briefing — pre-rendered, voiced-ready answers at every depth

The AI can start speaking a coherent answer in **under 2 seconds** for any level of abstraction the user asks about: project, architecture, module, file, concept. Each briefing is short (10–30s of speech), confident, and **stops** — you steer from there. Briefings are deterministic (served from cache), not synthesized per request.

Examples:
- "What does this do?" → 12s project opener.
- "Show me the architecture." → 25s tour of modules + how they connect.
- "Tell me about payments." → 15s module pitch.
- "What's idempotency doing in here?" → 10s concept explanation.

**Why briefings, not live LLM answers:** the first-response latency kills the conversational feel. A live LLM call is 3-10s to first word plus TTS time. A briefing starts speaking in <500ms. The LLM is still in the loop — it **writes** briefings during cache warming, and it handles anything the cache can't (with a graceful "let me pull that up…" buffer).

### 1.2 The Navigator — a breadcrumb stack you can talk to

Think browser history, but for comprehension. You start at *project overview*; ask about the ledger → push `module/ledger`; ask what double-entry bookkeeping is → push `concept/double-entry`; say "go back" → pop to module/ledger; say "back to the overview" → pop all the way. At every moment, the system knows *exactly* where you are and what you came from, and surfaces that as a breadcrumb.

Voice → stack operations:
- "deeper" / "more detail" / "tell me more" → push appropriate child
- "tell me about X" → push `module/X` (or concept/X)
- "go back" / "up a level" → pop
- "back to the overview" / "start again" → popTo(project)
- "where are we" → narrated breadcrumb
- interrupt mid-narration → capture resume cursor; pop back later picks up mid-sentence

### 1.3 The Comprehension Map — passive tracking, reviewable later

Every moment of the session nudges a model of what you understand. Not binary — **levels of confidence**:

| Level | How it's earned |
|---|---|
| `unknown` | default |
| `mentioned` | AI said the name; user didn't engage |
| `heard` | user listened through ≥N seconds of narration about it |
| `engaged` | user asked a question referencing it |
| `explained` | AI delivered a direct explanation (briefing or skill) |
| `confirmed` | user said a confirmation phrase ("got it", "makes sense", "right, that's clear") |

Visualization:
- **Live overlay** (opt-in toggle) during the session — a grid where each cell is a module/file/concept, colored by comprehension level. Cells light up as you go.
- **Review mode** at `/review/:repoId` — opens the same grid outside a session. Click any cell → replay the briefing you got for it.

## 2. What we have vs. what we need

| Mechanic | Have | Need |
|---|---|---|
| Briefing | Context cache with raw project/module/file summaries. `narration:quick_answer` fast path for "what is this about" questions (60ms). `session:quick_preview` event with git stats in <1s. 5 visual layers in the frontend. | Briefings table in DB. `BriefingComposer` that turns cached summaries into TTS-ready text (no bullets, natural transitions, paced for speech). Briefing delivery wired into session start. Fallback to LLM on cache miss, with a spoken buffer ("let me pull that up…"). |
| Navigator | Linear `state.areaIndex` + `state.segmentIndex` + `visualLayer` (1–5). `command:next/previous/skip/dive_deeper`. | `NavigatorState` with `stack: NavigationFrame[]`. Push/pop/popTo operations. Voice vocabulary (~25 phrases) mapped to stack ops. "Where are we" responder. Resume cursor per frame. Breadcrumb UI. |
| Comprehension | `UnderstandingRepo` with 5 layers. `session:heatmap` event. `UnderstandingMap` React component. Status updates during skill calls. | 6-level model (`unknown → mentioned → heard → engaged → explained → confirmed`). Passive transition rules driven by narration + utterances. Live overlay toggle in Room. `/review/:repoId` route. Dev-API read endpoints. |

Infrastructure we already have that underpins all three:
- `/api/dev/*` REST surface — we can drive + assert everything programmatically.
- Cassette-backed LLM adapter — no live API cost during tests.
- Trace event stream — every transition is already observable.
- Dev session registry — tests can hold multiple sessions simultaneously.

## 3. Detailed data shapes

### 3.1 Briefing

```ts
interface Briefing {
  id: string;                    // "project", "arch/root", "module/payments", "module/payments/capture.ts", "concept/idempotency"
  layer: 'project' | 'architecture' | 'module' | 'file' | 'concept';
  title: string;                 // "Tetherline" | "Payments module"
  opener: string;                // TTS-ready — the 10–30s spoken pitch; no bullets, natural transitions
  detail?: string;               // optional 30–60s deeper version (if user says "more")
  talkingPoints: string[];       // 3–5 follow-up hooks the AI can expand on
  children: string[];            // ids the user is likely to drill into
  parent: string | null;
  visualCue?: { kind: 'diagram_focus' | 'code_panel' | 'file_list' | 'none'; ref?: string };
  estimatedSeconds: number;
  sourceHash: string;            // hash of inputs — drives invalidation
  cachedAt: string;
}
```

Stored in the context-cache DB alongside existing module/file summaries. Regenerated when `sourceHash` differs.

### 3.2 Navigator

```ts
interface NavigationFrame {
  briefingId: string;
  enteredAt: string;             // ISO
  resumeCursor?: {
    segmentIndex: number;
    charOffset: number;
  };
  reason: 'user_asked' | 'dive_deeper' | 'tour_next' | 'resume_pop';
}

interface NavigatorState {
  stack: NavigationFrame[];       // top is current
  depth: number;
}
```

Operations on `SessionManager`:
- `nav.push(briefingId, reason)` — descend into a child briefing
- `nav.pop()` — back to parent, resume cursor applied
- `nav.popTo(predicate)` — walk up until match
- `nav.peek()` — current frame
- `nav.breadcrumb()` — string representation for "where are we"

### 3.3 Comprehension

```ts
type ComprehensionLevel =
  | 'unknown' | 'mentioned' | 'heard' | 'engaged' | 'explained' | 'confirmed';

interface ComprehensionItem {
  id: string;                      // matches briefing id when applicable
  repoPath: string;
  layer: 'project' | 'architecture' | 'module' | 'file' | 'code' | 'concept';
  label: string;
  level: ComprehensionLevel;
  lastTouchedAt: string;
  narrationSecondsHeard: number;
  questionsAsked: number;
  lastSessionId: string | null;
}
```

Passive transition rules:
- `narration:segment_ready` fires for a briefing → item.narrationSecondsHeard += segment.durationS; if crosses 5s, bump `mentioned → heard`
- `user:utterance` textually references item.label → `heard → engaged`
- Briefing delivered for item → `engaged → explained`
- Utterance matches confirmation phrase list → `explained → confirmed`
- Cooldown: same item can't transition more than once per 30s (prevents double-counting noisy transcripts)

## 4. New dev-API endpoints

On top of the existing `/api/dev/*`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dev/briefing/:id` | fetch a briefing by id |
| GET | `/api/dev/briefings?layer=` | list briefings (optionally filtered by layer) |
| POST | `/api/dev/briefing/rebuild` | force-regenerate (e.g. after prompt changes) |
| GET | `/api/dev/navigator/stack?sessionId=` | current nav stack |
| GET | `/api/dev/navigator/peek?sessionId=` | current frame only |
| POST | `/api/dev/navigator/push` | `{ sessionId, briefingId }` — test harness push |
| POST | `/api/dev/navigator/pop` | `{ sessionId }` |
| GET | `/api/dev/comprehension?repoPath=` | all items + levels |
| GET | `/api/dev/comprehension/item/:id?repoPath=` | single item |

## 5. Test surface — one file per behavior

The user was explicit: *"you creating your own tests to make sure it works. All the commands, going up and down in levels."* Every behavior gets a dev-API-driven integration test. Target: an agent can land a new behavior + test in under 30 seconds of execution.

```
test/integration/
├── briefing/
│   ├── project-opener-fires-within-2s.test.ts
│   ├── architecture-briefing-on-request.test.ts
│   ├── module-briefing-by-name.test.ts
│   ├── cache-miss-falls-back-gracefully.test.ts
│   └── briefing-text-is-tts-safe.test.ts      # no bullets, no markdown, paced
├── navigator/
│   ├── push-pop-basic.test.ts
│   ├── drill-three-levels-then-pop.test.ts
│   ├── back-to-overview-pops-all.test.ts
│   ├── where-are-we-narration.test.ts
│   ├── resume-cursor-mid-narration.test.ts
│   ├── voice-vocabulary-25-phrases.test.ts    # parameterized over natural phrasings
│   └── ambiguous-utterance-uses-llm-fallback.test.ts
├── comprehension/
│   ├── level-transitions.test.ts              # parameterized: each transition edge
│   ├── cooldown-prevents-double-count.test.ts
│   ├── persists-across-sessions.test.ts
│   ├── overlay-api-returns-full-grid.test.ts
│   └── confirmation-phrase-upgrades-level.test.ts
└── e2e/
    └── three-mechanics-together.test.ts       # full scenario: opener → drill → back → confirm
```

Every test uses the existing `tetherline.start()` harness + `MockLLMAdapter` so runs stay <5s each, no real API calls.

## 6. Rollout — five milestones

Each is shippable on its own; later ones unlock the next layer.

### M6 — Briefing data model + warming
- `briefings` table in context-cache DB
- `BriefingComposer` — takes raw cache entries + (optionally) calls the LLM to refactor into TTS-ready spoken text
- TTS-safety validator: asserts opener contains no markdown/bullets, stays under estimatedSeconds
- `GET /api/dev/briefing/:id`
- Tests: `briefing/briefing-text-is-tts-safe.test.ts`, unit tests on composer

### M7 — Briefing delivery + instant opener
- `narration:briefing` event type
- Session start: look up `briefings.get('project')` → emit briefing immediately (no LLM call, no ANALYZING block). Analysis continues in the background.
- `handleProjectLevelQuestionFromCache` (the fast path we just shipped) extended to route *any* briefing query
- Tests: `briefing/project-opener-fires-within-2s.test.ts`, `architecture-briefing-on-request.test.ts`, `cache-miss-falls-back-gracefully.test.ts`

### M8 — Navigator stack
- `NavigatorState` on `SessionManager`
- Voice → stack command map (shipped as a new module `session/navigator-vocab.ts`)
- `nav.push`, `nav.pop`, `nav.popTo`, `nav.peek`, `nav.breadcrumb`
- Resume cursor captured on interrupt
- New WS events: `navigator:push`, `navigator:pop`, `navigator:breadcrumb`
- Dev-API endpoints under `/api/dev/navigator/*`
- Tests: all of `navigator/*.test.ts`
- Frontend: breadcrumb strip in `Toolbar` or top of `Room`

### M9 — Comprehension tracking
- Migration: extend `UnderstandingRepo` to 6-level model (back-compat for existing data — map `'understood'` → `'confirmed'`)
- Passive transition rules hooked into `narration:segment_ready`, `user:utterance`, `narration:briefing`
- Confirmation-phrase list (configurable, starts with ~20 phrases)
- Cooldown tracker
- Dev-API endpoints under `/api/dev/comprehension/*`
- Tests: all of `comprehension/*.test.ts`

### M10 — Review mode + live overlay
- `/review/:repoId` React route — grid view outside a session, clickable cells replay briefings
- In-session overlay: a toggle in the Room chrome, shows comprehension colors on top of diagram/layers
- E2E test: open review page, see prior session's comprehension; live-overlay test via Playwright + dev API

## 7. How the three mechanics chain in a real session

```
t=0.0s   User clicks "Begin session"
t=0.1s   quick_preview event: repo stats visible
t=0.3s   Navigator initializes with stack=[project]
t=0.4s   narration:briefing event fires with briefings.get('project').opener
t=0.5s   TTS starts speaking the 12s project pitch
         Comprehension: items matching "project" go mentioned → heard as user listens
         Background: analyzer starts warming any stale briefings

t=12s    Opener ends. Orb returns to listening state.
t=14s    User: "Walk me through the architecture."
t=14.1s  Intent: briefing query for 'arch/root'. Navigator.push('arch/root')
t=14.2s  narration:briefing delivers arch briefing (cached)
         Breadcrumb: Project › Architecture

t=40s    User: "Tell me about payments."
t=40.1s  Navigator.push('module/payments')
t=40.2s  TTS starts payments briefing
         Comprehension: payments item → explained

t=55s    User (interrupting): "What's idempotency?"
t=55.1s  Navigator captures resume cursor on payments briefing
t=55.2s  Navigator.push('concept/idempotency')
t=55.3s  TTS delivers concept briefing (8s)

t=65s    User: "Got it, go back."
t=65.1s  Navigator.pop() → back to module/payments
t=65.2s  Comprehension: idempotency → confirmed
t=65.3s  TTS resumes payments: "As I was saying…"

t=90s    User: "Show me the map."
t=90.1s  Live overlay toggles on; user sees colored grid
         project=confirmed, architecture=explained, payments=explained,
         idempotency=confirmed, everything else=unknown
```

## 8. Open decisions to push back on

1. **Briefing generation — eager vs lazy.** Should cache warming generate briefings for *every* module up front (slow first-visit but instant everything after), or only the project-layer briefing + generate others on first access (fast first-visit but stutters on first drill-down)? **Proposal: eager for project + architecture + each top-level module; lazy for files and concepts.**

2. **Navigator depth cap.** Should the stack be bounded? A confused user could push 10 levels deep. **Proposal: soft cap at 5; 6th push triggers a "getting deep — say 'back to the overview' anytime" hint.**

3. **Comprehension regression.** Does the level ever go *down* — e.g., when code changes substantially in a module the user had `confirmed`? **Proposal: yes. File-level changes over a threshold invalidate back to `heard`; a new briefing on next access bumps it back up.** This preserves the "tethering" promise.

4. **Interrupt handling during a briefing.** Right now an interrupt stops TTS and routes the utterance to the intent classifier. With Navigator, should interrupts always be interpreted as navigation (`deeper`, `go back`, etc.) first, and only fall back to Q&A if no nav phrase is detected? **Proposal: yes — navigation is the primary verb in this app.**

5. **Review mode auth.** `/review/:repoId` is a standalone page. Do we need to auth it, or is loopback enough? **Proposal: loopback-only, same as dev API. This is a local-first tool.**

6. **Briefing style.** Should the opener be always *first-person* ("I'm going to walk you through…") or *second-person* ("You're looking at a tool that…") or project-first ("Tetherline is…")? **Proposal: project-first for the opener, second-person for drill-downs. Keeps it natural.**

7. **How much should the Navigator's voice vocabulary be hand-written vs learned?** Hand-written is predictable but brittle; learned (via LLM intent classifier) is flexible but slower. **Proposal: hand-written for the top ~25 canonical phrases (covers 90% of utterances), LLM fallback for the long tail.**

## 9. What I'd want you to push back on

- Is the 6-level comprehension model too granular? (Could collapse to 3: `unknown/heard/confirmed`.)
- Is "Navigator" the right primitive, or should it just be stack-augmented state inside `SessionManager` with no new abstraction name?
- Is `/review/:repoId` scope creep for M10, or is it the thing that makes the whole product feel valuable *between* sessions?
- Should briefings live in the same DB table as the existing cache entries, or get their own table? (Migrations either way.)
- Any product surface I'm missing — onboarding, multi-repo overviews, sharing briefings with teammates?

Once you've pushed back, I'll revise, then execute M6 → M10 in order. Each milestone lands with its full test suite + passing green before moving on.

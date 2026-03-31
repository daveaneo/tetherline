# Interactive Reviewer: Implementation Plan

This plan transforms the existing codebase from a linear commit-review tool into the guided-tour experience described in the vision document. It is organized into phases, each delivering a usable increment.

## Current State Summary

The monorepo (`packages/shared`, `packages/backend`, `packages/frontend`, `packages/cli`) has working:
- Git analysis pipeline (commit reading, diff parsing, heuristic clustering)
- Claude-powered intelligence (semantic clustering, narrative generation, architecture graphs, concern detection)
- WebSocket-based session state machine with linear navigation
- React frontend with architecture diagram (React Flow), code snippets, diff view, understanding heatmap
- Voice output (OpenAI TTS + browser fallback) and voice input (Web Speech API)
- SQLite persistence for sessions, areas, heatmaps, concerns, settings, repositories
- Lobby with repo management, session orchestration with auto-advance narration

What's missing: the five-layer understanding model, the skills system, progressive-zoom diagrams, the persistent "room" layout, deviation tracking, the two entry modes (Full Walkthrough vs Updates), and the 20-second silence rule.

---

## Phase 1: The Room and Progressive Zoom

**Goal:** Replace the current phase-based page transitions with the persistent room layout. Implement progressive zoom on the architecture diagram. Establish the greeting flow as a design pattern.

### 1.1 Room Layout

**File:** `packages/frontend/src/components/session/SessionView.tsx`

The current `SessionView` renders different components per phase inside `AnimatePresence mode="wait"`, which fades between entirely different views. Replace this with a persistent three-zone layout:

- **Left panel (50-60% width):** Always renders `ArchitectureDiagram`. Never unmounts.
- **Right panel (40-50% width):** Renders context-dependent content (code, diff, explanation, heatmap summary). This panel morphs between content types using `AnimatePresence`.
- **Bottom bar (fixed height ~80px):** Narration subtitles. Always visible. Replace the current `NarrationPlayer` floating overlay.

The phases (`ANALYZING`, `PREVIOUSLY_ON`, `HEATMAP`, `OVERVIEW`, `AREA_WALKTHROUGH`, etc.) now control *what's shown in each zone* rather than replacing the entire view. The diagram stays mounted and animates between states.

Create new component: `packages/frontend/src/components/room/Room.tsx`
Create new component: `packages/frontend/src/components/room/ContentPanel.tsx`
Create new component: `packages/frontend/src/components/room/NarrationBar.tsx`

Modify: `packages/frontend/src/App.tsx` -- render `Room` instead of `SessionView` when in session.

### 1.2 Greeting Flow (Design Pattern)

The AI-speaks-during-analysis pattern already exists in the orchestrator and should be preserved as a first-class design pattern. While the backend analyzes the repository, the AI is not silent -- it greets the user and sets context.

**Requirement:** The moment a session starts, before analysis completes, the AI begins speaking. For a Full Walkthrough: "Let me take a look at this project..." For Updates: "Welcome back. Let me see what's changed..." This happens via a pre-baked narration segment triggered immediately on `session:start`, independent of the analysis pipeline.

**File:** `packages/frontend/src/hooks/useSessionOrchestrator.ts` -- the orchestrator already fires greeting narration during the `ANALYZING` phase. This behavior must be preserved through the Room refactor. The greeting is not optional -- it is the user's first impression that the AI is a guide, not a loading spinner.

**File:** `packages/backend/src/session/manager.ts` -- on session start, emit a `narration:greeting` event before kicking off the analysis pipeline. The greeting content varies by entry mode and whether this is a first visit or return visit.

### 1.3 Progressive Zoom on Architecture Diagram

**File:** `packages/frontend/src/components/diagrams/ArchitectureDiagram.tsx`

Currently renders a flat graph of all nodes. Implement three zoom levels:

**Level 1 (Project):** 5-8 high-level boxes. These are top-level modules/packages. Each is a React Flow group node containing collapsed children. Use ELKjs for hierarchical layout instead of the current manual BFS layout.

**Level 2 (Component):** Clicking or saying "go deeper" on a Level 1 node expands it. Children nodes appear with animated spring transitions (framer-motion layout animations on React Flow nodes). Other Level 1 nodes shrink/fade to periphery.

**Level 3 (File/Code):** Expanding a Level 2 node shows actual files. Clicking a file shows code in the content panel.

New dependency: `elkjs` (add to `packages/frontend/package.json`).

**File:** `packages/frontend/src/components/diagrams/nodes/ModuleNode.tsx` -- extend to support collapsed/expanded states with expand/collapse button. Add visual indicator for zoom level.

**File:** `packages/backend/src/intelligence/prompts/architecture.ts` -- modify the architecture prompt to request hierarchical node data: parent-child relationships, nesting levels. The current flat node list needs a `parentId` field.

**Type change in** `packages/shared/src/types/analysis.ts`:
```typescript
// Add to DiagramNode:
parentId?: string;
zoomLevel: 1 | 2 | 3;
collapsed?: boolean;
```

### 1.4 Smooth Diagram Transitions

**File:** `packages/frontend/src/components/diagrams/ArchitectureDiagram.tsx`

When the AI narrates about a component, the diagram should:
1. Smoothly pan to center the relevant node (use React Flow's `fitView` with `nodes` filter and `duration` option).
2. Highlight the node with a glow effect (CSS box-shadow transition).
3. Optionally expand it one level if the narration goes into detail.

Wire the `visual:diagram_focus` server event to trigger these animations. Currently `focusedNodeId` is passed as a prop but doesn't trigger panning.

---

## Phase 2: Understanding Model and Entry Modes

**Goal:** Implement the five-layer understanding model. Add "Full Walkthrough" and "Updates" entry modes with distinct flows.

### 2.1 Five-Layer Understanding Model

**New file:** `packages/shared/src/types/understanding.ts`

```typescript
export interface UnderstandingLayer {
  level: 'project' | 'architecture' | 'component' | 'file' | 'code';
  percentage: number; // 0-100
  items: UnderstandingItem[];
}

export interface UnderstandingItem {
  id: string;
  name: string;
  parentId?: string;
  status: 'not_started' | 'partial' | 'understood' | 'stale';
  lastReviewedAt?: string;
  staleSince?: string;  // when underlying code changed after review
}

export interface UnderstandingState {
  repoPath: string;
  layers: UnderstandingLayer[];
  overallPercentage: number;
  lastUpdated: string;
}
```

**New DB table** in `packages/backend/src/db/database.ts`:
```sql
CREATE TABLE IF NOT EXISTS understanding (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('project', 'architecture', 'component', 'file', 'code')),
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  last_reviewed_at TEXT,
  stale_since TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_path, layer, item_id)
);
```

**New repository:** `packages/backend/src/db/repositories/understanding-repo.ts`

**Marking understanding:** The session manager (`packages/backend/src/session/manager.ts`) marks items as understood when:
- **Project layer:** Marked after the AI's project overview narration completes.
- **Architecture layer:** Marked after the architecture overview, per top-level component shown.
- **Component layer:** Marked when a component's narration segments are all completed.
- **File layer:** Marked when a file is shown in the content panel and the user doesn't skip it.
- **Code layer:** Marked when the user requests a deep dive or asks questions about specific logic.

**Staleness detection:** On session start, compare file hashes against `last_known_hash` in `file_familiarity`. Files changed since last review trigger staleness up the chain (file -> component -> architecture).

### 2.2 Entry Mode Selection

**File:** `packages/frontend/src/components/lobby/Lobby.tsx`

When clicking a repo that has prior sessions, show two options instead of immediately starting:
- **Full Walkthrough** -- starts from project level, top-down
- **Updates** -- starts from changes since last session, bottom-up

New shared type in `packages/shared/src/types/modes.ts`:
```typescript
export type EntryMode = 'full_walkthrough' | 'updates';
```

**File:** `packages/shared/src/types/ws-events.ts` -- add `entryMode` to `session:start` payload:
```typescript
{ type: 'session:start'; payload: { repoPath: string; sinceDays?: number; entryMode: EntryMode } }
```

### 2.3 Full Walkthrough Flow

**File:** `packages/backend/src/session/manager.ts`

New phase sequence for full walkthrough:
1. `PROJECT_OVERVIEW` -- AI narrates what the project does and why. Content panel shows a project summary card with key stats. Diagram shows the highest-level view. First-time repos get: "This is our first time looking at this project. Let me start with what it does and how it's built."
2. `ARCHITECTURE_OVERVIEW` -- AI narrates how the pieces connect. Diagram animates through the top-level components one by one.
3. `COMPONENT_TOUR` -- AI guides through each component. Diagram expands each component in turn. Content panel shows relevant code/docs.
4. `FILE_REVIEW` -- Within each component, AI highlights key files. Content panel shows code.
5. `CODE_DEEP_DIVE` -- Optional. User requests or AI suggests deep dives on complex logic.
6. `WRAP_UP` -- Understanding map updated, export offered.

New Claude prompt: `packages/backend/src/intelligence/prompts/project-overview.ts` -- given the file tree, README content, and package.json, generate a project overview narration.

### 2.4 Updates Flow

**File:** `packages/backend/src/session/manager.ts`

Modify the existing flow (which is already update-oriented) to:
1. Show understanding map with changed areas highlighted.
2. Tour through changes in order of significance.
3. After each change area, update the understanding model (bottom-up: code -> file -> component -> architecture -> project).

The existing `PREVIOUSLY_ON` -> `HEATMAP` -> `OVERVIEW` -> `AREA_WALKTHROUGH` flow is close to this. Wire it to update the understanding model as areas are completed.

### 2.5 Updates with No Changes

**File:** `packages/backend/src/session/manager.ts`

When the user selects Updates but there are zero new commits since their last session, the AI should not show an empty tour. Instead:

1. Detect zero new commits after the git analysis step.
2. AI narrates: "Nothing's changed since your last review. Your understanding is current. Want to do a full walkthrough instead, or explore something specific?"
3. Wait for the user's response.
4. If the user says "full walkthrough" or similar, switch the session to Full Walkthrough mode and begin the walkthrough flow from 2.3.
5. If the user names a specific area, treat it as a navigation request and invoke the Navigate skill to go there.
6. If the user says "never mind" or wants to leave, return to the lobby.

**File:** `packages/shared/src/types/ws-events.ts` -- add a `session:mode_switch` event so the backend can transition from Updates to Full Walkthrough mid-session:
```typescript
| { type: 'session:mode_switch'; payload: { newMode: EntryMode } }
```

---

## Phase 3: Skills System

**Goal:** Implement the AI skills architecture. Each skill has a trigger detection, a backend execution, and a frontend visual output.

### 3.1 Skills Registry

**New file:** `packages/backend/src/skills/registry.ts`

```typescript
export interface Skill {
  name: string;
  description: string;
  triggerPatterns: string[];  // used by the AI to classify user intent
  execute: (context: SkillContext, params: Record<string, unknown>) => Promise<SkillResult>;
}

export interface SkillContext {
  currentArea?: AreaWithContent;
  currentFile?: string;
  zoomLevel: number;
  repoPath: string;
  fileTree: string[];
  intelligence: IntelligenceAnalyzer;
}

export interface SkillResult {
  type: 'diagram' | 'code' | 'diff' | 'comparison' | 'explanation' | 'annotation';
  narration: string;
  visualPayload: Record<string, unknown>;
  diagramChanges?: { focusNodeId?: string; expandNodeId?: string; zoomLevel?: number };
  understandingUpdates?: { layer: string; itemId: string; status: string }[];
}
```

### 3.2 Intent Classification

**New file:** `packages/backend/src/skills/intent-classifier.ts`

When the user speaks (currently routed as `command:ask` or voice commands), classify the intent:

1. First check against the existing command vocabulary (next, previous, skip, pause, etc.) -- these are navigation, not skills.
2. If not a navigation command, send the transcript to Claude with a lightweight classification prompt: "Given this user utterance in the context of a code review, which skill should be invoked? Return the skill name, extracted parameters, and a confidence score from 0 to 1."

**New prompt:** `packages/backend/src/intelligence/prompts/intent.ts`

The classifier returns a skill name, parameters, and confidence. Routing logic:

- **Confidence >= 0.7:** Invoke the skill directly.
- **Confidence < 0.7:** The AI asks for clarification instead of guessing. Example: "I'm not sure if you want me to show you the code or explain the architecture. Which would you prefer?"

### 3.3 Intent Misclassification Recovery

**File:** `packages/backend/src/skills/intent-classifier.ts`

If the AI invokes the wrong skill, the user can say "that's not what I meant," "no, I wanted to see the code," or similar correction phrases. Handle this:

1. Maintain a `lastClassification` state in the session. When a correction phrase is detected, the classifier re-runs with additional context: the original utterance, the skill that was incorrectly invoked, and the user's correction.
2. The re-classification prompt includes: "The user said '[original utterance]'. I classified this as [skill_name] but the user corrected me with '[correction]'. What did they actually want?"
3. The AI acknowledges the correction naturally: "Ah, let me show you the code instead." Then invokes the correct skill.

Detection of correction phrases: add a pre-check in the classifier for phrases like "no," "that's not what I meant," "I meant," "actually I wanted," "not that." If detected and a skill was just invoked, treat as a re-classification request rather than a new intent.

### 3.4 Implement Core Skills

Each skill is a file in `packages/backend/src/skills/`:

- `visualize.ts` -- Calls Claude to generate a focused diagram (data flow, dependency chain, etc.). Returns diagram nodes/edges for the content panel.
- `explain.ts` -- Generates narration segments for whatever was asked about. Default skill during walkthroughs.
- `compare.ts` -- Fetches before/after code for a file or function. Returns diff data. Frontend uses `shiki-magic-move` for animated token transitions.
- `critique.ts` -- Calls Claude with the current code context and asks for quality/design assessment. Returns narration + annotated code.
- `summarize.ts` -- Generates a condensed overview. Collapses the diagram to fewer nodes.
- `navigate.ts` -- Changes zoom level, focuses a node, or loads a different file. No Claude call needed for basic navigation.
- `teach.ts` -- Explains a concept in context. Calls Claude with the code example and asks for a teaching explanation.
- `annotate.ts` -- Creates a persistent note. Stores in DB.

### 3.5 Frontend Skill Rendering

**File:** `packages/frontend/src/components/room/ContentPanel.tsx`

The content panel receives a `SkillResult` and renders the appropriate visual:
- `type: 'code'` -- renders `CodeSnippet` (upgrade to use `shiki` v4 for proper syntax highlighting instead of the current plain-text renderer in `packages/frontend/src/components/code/CodeSnippet.tsx`)
- `type: 'diff'` -- renders side-by-side using `react-diff-viewer-continued`
- `type: 'comparison'` -- renders animated code morphing using `shiki-magic-move`
- `type: 'diagram'` -- renders a secondary focused diagram (not the main architecture diagram)
- `type: 'explanation'` -- renders formatted text with inline code references
- `type: 'annotation'` -- renders a note card with save/dismiss

### 3.6 Wire Voice Input to Skills

**File:** `packages/frontend/src/lib/speech-recognition.ts`

Currently, voice input is split into two categories: known command phrases and questions (anything longer than 3 words). Change this:

1. All recognized speech goes to the backend as a unified `user:utterance` event.
2. The backend's intent classifier decides whether it's navigation, a skill invocation, or a question.
3. The backend responds with appropriate events.

**File:** `packages/shared/src/types/ws-events.ts` -- add:
```typescript
| { type: 'user:utterance'; payload: { text: string; timestamp: number } }
```

Remove the current `command:ask` event in favor of the unified utterance.

---

## Phase 4: Deviation Tracking and Tour Intelligence

**Goal:** Make the AI a smart guide that tracks progress, handles deviations, and resumes gracefully.

### 4.1 Tour Plan

**New file:** `packages/backend/src/session/tour-plan.ts`

The tour plan is a tree of items the AI intends to cover:
```typescript
export interface TourPlan {
  items: TourItem[];
  currentIndex: number;
  coveredItemIds: Set<string>;
}

export interface TourItem {
  id: string;
  parentId?: string;
  type: 'project' | 'architecture' | 'component' | 'file' | 'code';
  name: string;
  nodeId?: string;        // corresponding diagram node
  filePath?: string;
  estimatedDurationSec: number;
  children: TourItem[];
  covered: boolean;
  skipped: boolean;
}
```

On session start, the intelligence layer generates a tour plan. During the tour, each completed narration segment marks items as covered. When the user deviates, the plan notes which items the deviation touched.

### 4.2 Deviation Detection and Tracking

**File:** `packages/backend/src/session/manager.ts`

When the user invokes a skill that takes them off the planned path (e.g., asks about a different component, navigates to an unrelated file):

1. Push the current tour position onto a `deviationStack`.
2. Track all items the user sees during the deviation.
3. When the skill/deviation concludes (user says "back" or "continue" or falls silent for 20 seconds), pop the stack.
4. Resume the tour, skipping any items that were already covered during the deviation.

The AI's resume narration: "Let's pick back up. We were looking at [X]. I'll skip [Y] since we already covered that."

### 4.3 The 20-Second Silence Rule

**File:** `packages/frontend/src/hooks/useSessionOrchestrator.ts`

After the AI finishes narrating and the user hasn't spoken or interacted for 20 seconds:
1. AI speaks: "Want to keep exploring, or shall I continue the walkthrough?"
2. Timer resets. AI waits indefinitely.
3. If the user says "continue" or similar, resume tour.
4. If the user asks another question, treat as continued deviation.

Implementation: a `silenceTimer` ref in the orchestrator. Reset on any user interaction (voice, keyboard, click). Fire a `silence:timeout` event to the backend after 20 seconds.

### 4.4 Smart Deviation Check-ins

**File:** `packages/backend/src/session/manager.ts`

After the AI answers a question or completes a skill invoked by deviation, it says: "Want to explore more, or shall we keep going?" This is a single check-in, not repeated nagging.

Track whether a check-in has already been issued for the current deviation. Only issue one per deviation.

---

## Phase 5a: Critical Edge Cases and Error Recovery

**Goal:** Handle the failure modes and edge cases that would break the experience in production.

### 5a.1 Brand New Repo (No Git History)

**File:** `packages/backend/src/session/manager.ts`

Detect zero commits. Fall back to Full Walkthrough only. AI generates architecture from file tree alone. Skip the "Updates" option in the lobby.

### 5a.2 Massive Monorepo (1000+ Files)

**File:** `packages/backend/src/intelligence/prompts/architecture.ts` -- already truncates file tree at 500 entries. Add intelligent sampling: group by top-level directory, send directory summaries instead of full file lists.

**File:** `packages/backend/src/git/analyzer.ts` -- add pagination for commit reading. Process in batches of 100.

**File:** `packages/frontend/src/components/diagrams/ArchitectureDiagram.tsx` -- cap visible nodes per zoom level. Level 1 shows max 8, Level 2 shows max 15 within an expanded node.

### 5a.3 No API Key (Anthropic)

**File:** `packages/backend/src/session/manager.ts` -- already has heuristic fallback. Enhance it: generate a basic architecture diagram from directory structure alone. Narration uses template sentences rather than AI-generated ones. Understanding map still works.

**File:** `packages/frontend/src/components/lobby/Lobby.tsx` -- show a banner: "Add an Anthropic API key in settings for AI-powered narration and analysis."

### 5a.4 WebSocket Disconnection Mid-Session

**File:** `packages/backend/src/session/manager.ts` -- `cleanup()` already persists state snapshot. On reconnect, restore from snapshot. The frontend's `useWebSocket.ts` already handles reconnection with backoff.

Add: on reconnect, send a `session:resume` event automatically if there's an active session ID in the frontend store. The AI acknowledges the reconnection: "Looks like we got disconnected. Let me pick up where we left off."

### 5a.5 AI Rate Limiting or Errors

**File:** `packages/backend/src/intelligence/claude-client.ts` -- add retry with exponential backoff (3 attempts). On persistent failure, emit a recoverable error and fall back to heuristic mode for that step.

**File:** `packages/frontend/src/components/layout/ErrorBanner.tsx` -- show "AI temporarily unavailable, continuing with basic analysis" instead of blocking the session.

### 5a.6 Unfamiliar Language

**File:** `packages/backend/src/intelligence/prompts/system.ts` -- add instruction: "If the codebase uses languages the user may not know, explain language-specific idioms and patterns. Don't assume familiarity."

**File:** `packages/backend/src/session/manager.ts` -- detect languages via `detectLanguages()`. If the detected language set differs from the user's stated preferences (new setting), enable the Teach skill automatically for language-specific constructs.

---

## Phase 5b: Enhancements and Visual Polish

**Goal:** Elevate the experience with better visuals, richer narration, and persistent annotations. These are not blockers -- the product works without them.

### 5b.1 Code Visualization Upgrade

**File:** `packages/frontend/src/components/code/CodeSnippet.tsx`

Replace the current plain-text renderer with `shiki` v4 for proper syntax highlighting with theme support.

**New file:** `packages/frontend/src/components/code/CodeMorphing.tsx`

Integrate `shiki-magic-move` for animated code transitions. Used by the Compare skill when showing before/after code.

**New file:** `packages/frontend/src/components/code/DiffViewEnhanced.tsx`

Integrate `react-diff-viewer-continued` for proper side-by-side diff rendering with syntax highlighting. Replace the current `DiffView.tsx`.

### 5b.2 Understanding Map Upgrade

**File:** `packages/frontend/src/components/heatmap/UnderstandingMap.tsx`

Replace the current simple grid with `nanovis` treemap/sunburst visualization. The understanding map should:
- Show the five layers as concentric rings (sunburst) or nested rectangles (treemap).
- Color by understanding status (green/yellow/red).
- Be interactive: click a section to zoom into that area.
- Show percentage at each level.

### 5b.3 ELKjs Layout Integration

**File:** `packages/frontend/src/components/diagrams/ArchitectureDiagram.tsx`

Replace the current manual BFS layout with ELKjs for hierarchical graph layout. ELKjs handles:
- Hierarchical/nested layouts (needed for progressive zoom).
- Edge routing that avoids node overlap.
- Animated layout transitions when nodes expand/collapse.

### 5b.4 Narration Improvements

**File:** `packages/backend/src/intelligence/prompts/system.ts`

Refine the system prompt for the guided-tour persona:
- The AI should use conversational transitions: "Now let's look at..." / "This is interesting..." / "One thing to note here..."
- Never use bullet points or markdown formatting in narration (it's spoken aloud).
- Reference spatial context: "Over on the left you can see..." / "If you look at the diagram..."

**File:** `packages/backend/src/tts/provider.ts`

Add SSML support for OpenAI TTS to control pacing, pauses, and emphasis in narration.

### 5b.5 Persistent Annotations

**New DB table** in `packages/backend/src/db/database.ts`:
```sql
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  file_path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  node_id TEXT,
  layer TEXT,
  content TEXT NOT NULL,
  created_by TEXT DEFAULT 'user',
  session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Annotations persist across sessions. The AI surfaces relevant annotations when revisiting an area.

---

## Dependency Summary

New npm dependencies to add:

| Package | Purpose | Install to |
|---|---|---|
| `elkjs` | Hierarchical graph layout | `packages/frontend` |
| `shiki` (v4) | Syntax highlighting | `packages/frontend` |
| `shiki-magic-move` | Animated code morphing | `packages/frontend` |
| `react-diff-viewer-continued` | Side-by-side diffs | `packages/frontend` |
| `nanovis` | Treemap/sunburst charts | `packages/frontend` |

Already installed: `@xyflow/react`, `framer-motion`, `@anthropic-ai/sdk`, `better-sqlite3`, `simple-git`, `zustand`.

---

## Phase Priority and Sequencing

| Phase | Priority | Estimated Effort | Depends On |
|---|---|---|---|
| Phase 1: Room + Progressive Zoom + Greeting | **P0** | 1-2 weeks | Nothing |
| Phase 2: Understanding Model + Entry Modes | **P0** | 1-2 weeks | Phase 1 |
| Phase 3: Skills System + Intent Classification | **P1** | 2-3 weeks | Phase 1 |
| Phase 4: Deviation Tracking | **P1** | 1-2 weeks | Phase 3 |
| Phase 5a: Critical Edge Cases | **P1** | 1 week | Phases 1-2 |
| Phase 5b: Visual Enhancements | **P2** | 2-3 weeks | Phases 1-4 |

Phases 1 and 2 are the foundation -- the room layout and understanding model are prerequisites for everything else. Phase 3 (skills) and Phase 4 (deviation tracking) can be developed in parallel by different contributors. Phase 5a should be tackled as soon as the core phases are stable -- these are the cases that break the product in the real world. Phase 5b is continuous polish that can be done incrementally.

---

## Key Files Quick Reference

| Area | Key Files |
|---|---|
| Session state machine | `packages/backend/src/session/manager.ts` |
| WebSocket events | `packages/shared/src/types/ws-events.ts` |
| Shared types | `packages/shared/src/types/analysis.ts`, `packages/shared/src/types/understanding.ts` (new) |
| Frontend entry | `packages/frontend/src/App.tsx` |
| Current session view | `packages/frontend/src/components/session/SessionView.tsx` |
| Architecture diagram | `packages/frontend/src/components/diagrams/ArchitectureDiagram.tsx` |
| Narration orchestrator | `packages/frontend/src/hooks/useSessionOrchestrator.ts` |
| Voice recognition | `packages/frontend/src/lib/speech-recognition.ts` |
| AI intelligence | `packages/backend/src/intelligence/analyzer.ts` |
| AI prompts | `packages/backend/src/intelligence/prompts/*.ts` |
| Database schema | `packages/backend/src/db/database.ts` |
| State store | `packages/frontend/src/state/session-store.ts` |
| Skills registry | `packages/backend/src/skills/registry.ts` (new) |
| Intent classifier | `packages/backend/src/skills/intent-classifier.ts` (new) |
| Tour plan | `packages/backend/src/session/tour-plan.ts` (new) |

#!/usr/bin/env bash
# Synthetic mirror of Tetherline's structure — frozen content for the
# self-on-self truth test. The previous design pointed at REPO_ROOT
# directly, which meant every commit changed the file tree → changed
# the analysis prompt → invalidated the cassette. This fixture is a
# stable snapshot: the cassette recorded against it stays valid until
# this script itself is edited.
#
# What the fixture captures:
#   - Multi-package monorepo (backend / frontend / shared) so workspace
#     detection has a real shape to pick up.
#   - Substantive per-package READMEs that name the actual concepts
#     Hermes should surface (briefing, comprehension, voice, etc.).
#   - A few representative files per package for the file tree.
#   - docs/ + test/ as top-level peers so non-workspace top-dirs are
#     covered too.

set -euo pipefail
DEST="${1:-/tmp/tetherline-mirror}"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@tetherline.test'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@tetherline.test'

git init -q -b main

mkdir -p packages/backend/src/session packages/backend/src/intelligence
mkdir -p packages/frontend/src/components packages/frontend/src/state
mkdir -p packages/shared/src/types
mkdir -p docs test

cat > README.md <<'EOF'
# tetherline

Voice-led AI code review. Hermes — the in-session guide — narrates
spoken briefings about a codebase, tracks what the user has actually
engaged with via a layered comprehension model, and surfaces what's
drifted since last time.

## packages/backend
The analysis pipeline + Hermes himself. Owns the SessionManager state
machine, the LLM intelligence layer (briefing composer, quiz
generator, depth modifiers), and the SQLite-backed cache that warms
context-cache rows + briefings before voice ever fires. The non-
obvious detail: every emit is gated by a userSpeaking floor-control
flag so the AI never overlaps the user.

## packages/frontend
React + Vite app. Renders the radial diagram, the BriefingCard
overlay, the CodePanel for code-layer drilling, and the GapsPanel
"what don't I know" surface. The interesting constraint is that
*everything* is voice-first — every visual affordance has a paired
utterance vocabulary in navigator-vocab.

## packages/shared
TypeScript types shared between backend and frontend. WebSocket event
schemas (ClientEvent / ServerEvent), Briefing / Comprehension /
session types. No runtime code lives here.

## docs
Vision and testing master plans. Where the *why* lives.

## test
End-to-end test harness — boots the real backend, drives sessions
over the dev API, asserts comprehension truth.
EOF

cat > package.json <<'EOF'
{
  "name": "tetherline-monorepo",
  "private": true,
  "scripts": { "dev": "echo dev", "test": "vitest run" }
}
EOF

cat > pnpm-workspace.yaml <<'EOF'
packages:
  - 'packages/*'
EOF

# ─── backend ───────────────────────────────────────────────────────
cat > packages/backend/README.md <<'EOF'
# @tetherline/backend

The analysis pipeline + Hermes the AI guide. Owns the SessionManager
state machine and the LLM intelligence layer.

The central concept here is the `briefing`: pre-rendered, TTS-safe
spoken pitches per layer (project, architecture, module, file, code).
SessionManager dispatches ClientEvents over WebSocket and emits
ServerEvents the frontend reacts to. Every new feature ends up
touching SessionManager — it's the central nervous system.

The non-obvious detail: outbound narration is gated by a
userSpeaking floor-control flag with a 600ms cooldown after the user
stops, so Hermes never overlaps the user. The briefing composer
includes file content hashes in the briefing's source hash, which
drives drift detection — when code under a confirmed comprehension
item changes, the level regresses to heard.
EOF

cat > packages/backend/package.json <<'EOF'
{ "name": "@tetherline/backend" }
EOF

cat > packages/backend/src/session/manager.ts <<'EOF'
// SessionManager — state machine for an interactive review session.
// Receives ClientEvents over WebSocket, emits ServerEvents, gates
// narration on the user's voice floor.
export class SessionManager { /* ... */ }
EOF

cat > packages/backend/src/intelligence/briefing-composer.ts <<'EOF'
// Composes briefings from cached project / module / file rows.
// Layered: project → architecture → module → file → code.
export class BriefingComposer { /* ... */ }
EOF

# ─── frontend ──────────────────────────────────────────────────────
cat > packages/frontend/README.md <<'EOF'
# @tetherline/frontend

React + Vite. Renders the radial diagram and the BriefingCard,
manages voice input via push-to-talk (hold space), and runs a
useSessionOrchestrator hook that drains streamed answer chunks
sequentially through TTS.

The CodePanel opens automatically when a code-layer briefing fires —
the active line range advances live as Hermes walks each chunk. The
GapsPanel surfaces "what don't I know" via the comprehension map,
including cross-session recall items (per-item commits-since-last-
touch) so the user can pick up where they left off.
EOF

cat > packages/frontend/package.json <<'EOF'
{ "name": "@tetherline/frontend" }
EOF

cat > packages/frontend/src/state/session-store.ts <<'EOF'
// Zustand session store. Holds Hermes's state — current briefing,
// streamed answer chunks, comprehension map, recall items.
export const useSessionStore = (() => {}) as any;
EOF

cat > packages/frontend/src/components/CodePanel.tsx <<'EOF'
// Opens when currentBriefing.layer === 'code'. Renders the file
// content with the active range highlighted.
export function CodePanel() { return null; }
EOF

# ─── shared ────────────────────────────────────────────────────────
cat > packages/shared/README.md <<'EOF'
# @tetherline/shared

Type contracts shared between backend and frontend. WebSocket event
schemas (ClientEvent / ServerEvent), Briefing / Comprehension /
SessionState types. No runtime code.
EOF

cat > packages/shared/package.json <<'EOF'
{ "name": "@tetherline/shared" }
EOF

cat > packages/shared/src/types/briefing.ts <<'EOF'
export type BriefingLayer = 'project' | 'architecture' | 'module' | 'file' | 'code';
export interface Briefing { id: string; layer: BriefingLayer; opener: string; }
EOF

# ─── docs ───────────────────────────────────────────────────────────
cat > docs/VISION.md <<'EOF'
# Vision

Hermes guides developers through codebases moving faster than they
can absorb. Voice-first, with comprehension-tracked depth so passive
listening doesn't certify the user — only active engagement (quiz,
walking through code) earns deeper levels.
EOF

cat > docs/TESTING.md <<'EOF'
# Testing strategy

Three layers: unit (pure functions), frontend (jsdom + React), and
integration (real backend on ephemeral port via the dev API harness).
Cassette-backed truth tests prove Hermes can summarize real
codebases meaningfully, not just produce non-empty strings.
EOF

# ─── test ───────────────────────────────────────────────────────────
cat > test/harness.ts <<'EOF'
// Dev API harness — spins up the real backend on an ephemeral port,
// installs a MockLLMAdapter or CassetteLLMAdapter, returns a DevClient
// that drives sessions over HTTP without a UI.
export const tetherline = {} as any;
EOF

GIT_AUTHOR_DATE='2026-04-01T10:00:00Z' GIT_COMMITTER_DATE='2026-04-01T10:00:00Z' \
  git add -A
GIT_AUTHOR_DATE='2026-04-01T10:00:00Z' GIT_COMMITTER_DATE='2026-04-01T10:00:00Z' \
  git commit -q -m "Initial Tetherline-mirror scaffolding"

echo "fixture ready: $DEST"
git log --oneline

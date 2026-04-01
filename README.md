# Interactive Reviewer

An AI-powered guided tour of your codebase. Point it at any git repo and an AI guide walks you through it — narrating what the project does, how it's built, and what changed recently. Everything is voice-driven: the AI speaks, you speak back.

## What It Does

You select a repository, choose **Full Walkthrough** (learn the whole project) or **Updates** (what changed this week), and the AI leads you through an interactive narrated review. It shows architecture diagrams, code snippets, and visual overviews — all synchronized with voice narration that you can interrupt, question, and steer at any time.

Think of it as having a senior engineer walk you through the codebase, pointing at a whiteboard, answering your questions, and never losing their place.

## Key Features

### Voice-First Interaction
Everything works by voice after the initial click. Say "next", "skip", "dive deeper", "what does this function do?", or "create a ticket for this." The AI listens, responds, and adapts the tour based on what you ask.

### Progressive Zoom (5 Visual Layers)
Never see the full complexity at once. The view starts simple and zooms in on demand:
1. **Book Jacket** — Plain language: what the project does, key stats
2. **Conceptual Flow** — Animated storyboard: how it works step by step
3. **Architecture** — Node diagram with progressive reveal (pieces appear as the AI narrates)
4. **Component** — Zoomed into one module with code snippets
5. **Code** — Full file view with line-by-line highlights

### Smart Updates Mode
For weekly reviews. The AI ranks changes by impact (not line count), groups them by theme, leads with "why it matters", and surfaces risk flags. On quiet weeks, it suggests unexplored areas instead of showing an empty screen.

### AI Skills System
Eight built-in skills triggered by natural language:
- **Explain** — "What does this module do?"
- **Visualize** — "Show me how auth connects to the database"
- **Compare** — "How did this change from last week?"
- **Critique** — "Is this approach good?"
- **Summarize** — "Give me the quick version"
- **Navigate** — "Go to the payment module"
- **Teach** — "What's the observer pattern they're using here?"
- **Annotate** — "Flag this for the team"

### Action Layer
Go from understanding to action without leaving the review:
- **Create GitHub Issues** — "Create a ticket for this" drafts an issue with full code context, editable before submission
- **Save Notes** — "Flag this" persists annotations that resurface when you revisit
- **Share Explanations** — "Share this" generates a copyable markdown snippet

### 5-Layer Understanding Model
Tracks your comprehension across five levels: Project, Architecture, Component, File, and Code. Understanding decays when code changes. The AI prioritizes areas where your understanding is weakest.

### Onboarding Mode
A structured 5-day program for new team members:
- Day 1: Project overview
- Day 2: Architecture deep dive
- Day 3-4: Key components
- Day 5: Code patterns and conventions

### Monday Morning Digest
A weekly push notification (Slack or in-app) summarizing what changed across all your repos, ranked by importance, with one-click links to start walkthroughs.

### Deviation Tracking
When you go off-path during a tour (ask a question, explore a tangent), the AI tracks where you were. When you're done, it resumes — skipping anything you already covered during the detour.

### Fully Local
Everything runs on your machine. Git analysis, architecture diagrams, voice input, voice output — all local. The only external calls are to Claude for intelligence (via your API key or Claude Code CLI subscription).

## Tech Stack

- **Frontend**: React 19, Vite, React Flow, Framer Motion, Zustand, Tailwind CSS
- **Backend**: Express, WebSocket, SQLite (better-sqlite3), simple-git
- **Intelligence**: Claude API or Claude Code CLI (subscription)
- **Voice Output**: Kokoro TTS (local, 82M params, Apache 2.0) or OpenAI TTS
- **Voice Input**: Whisper STT (local, via faster-whisper) with echo cancellation, or Web Speech API
- **Code Visuals**: Shiki v4, shiki-magic-move, react-diff-viewer-continued
- **Diagrams**: React Flow + ELKjs hierarchical layout

## Quick Start

### Prerequisites
- Node.js 20+
- pnpm
- Python 3.10+ (for local voice)
- A Claude API key from [console.anthropic.com](https://console.anthropic.com), OR the `claude` CLI installed with an active subscription

### Setup

```bash
# Clone and install
git clone <repo-url>
cd interactive-reviewer
pnpm install

# Configure
cp .env.example .env
# Edit .env — set INTELLIGENCE_MODE and optionally ANTHROPIC_API_KEY

# Install local voice (optional but recommended)
python3 -m venv .venv
source .venv/bin/activate  # or: .venv/bin/activate
pip install kokoro faster-whisper soundfile
```

### Run

```bash
# Terminal 1: Start the local voice server (TTS + STT)
.venv/bin/python packages/backend/src/tts/audio-server.py --preload

# Terminal 2: Start the app
pnpm dev
```

Open **http://localhost:3847** in Chrome. Add a repo (local path or GitHub URL), select Full Walkthrough or Updates, and start talking.

### Voice Commands

| Say | Action |
|-----|--------|
| "next" / "continue" | Advance to next segment |
| "skip" | Skip current area |
| "go back" | Previous segment |
| "dive deeper" | Zoom into current topic |
| "zoom out" | Return to higher level |
| "pause" / "stop" | Pause everything |
| "resume" / "play" | Continue |
| "create a ticket" | Draft a GitHub issue |
| "save this" / "flag this" | Save a note |
| "share this" | Copy explanation to clipboard |
| "export slides" | Generate Reveal.js presentation |
| "export markdown" | Generate markdown summary |
| "exit" | Return to lobby |

Or just ask anything naturally — the AI figures out what you mean.

## Intelligence Modes

| Mode | Set via | How it works |
|------|---------|-------------|
| **Local** | `INTELLIGENCE_MODE=local` | Uses `claude` CLI with your subscription. Free. |
| **Cloud** | `INTELLIGENCE_MODE=cloud` | Uses Anthropic API. Requires `ANTHROPIC_API_KEY`. |
| **Auto** | `INTELLIGENCE_MODE=auto` (default) | Tries local first, falls back to cloud. |

## Architecture

```
packages/
  shared/     TypeScript types and constants (shared between all packages)
  backend/    Express + WebSocket server, git analysis, Claude intelligence,
              TTS/STT, session state machine, skills system, SQLite
  frontend/   React app with Room layout, progressive zoom layers,
              voice input/output, architecture diagrams
  cli/        npx entry point

test/
  fixtures/   Script-generated test repos (small + medium)
  harness/    Integration test harness (27 tests)
```

## Project Status

132 source files, ~12,400 lines of TypeScript. All features implemented, 27 integration tests passing. See `docs/vision.md` for the product vision and `docs/feature-plans.md` for the feature roadmap.

## License

MIT

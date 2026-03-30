# Interactive Reviewer

AI-powered weekly code review tool with voice narration, visual architecture diagrams, and exportable presentations.

## Quick Start

```bash
# Install dependencies
pnpm install

# Set your API keys in .env
cp .env.example .env
# Edit .env with your keys

# Development (backend + frontend with hot reload)
pnpm dev

# Or run the CLI against a repo
pnpm --filter interactive-reviewer dev -- /path/to/git/repo
```

## Architecture

Monorepo with 4 packages:
- `packages/shared` — TypeScript types and constants
- `packages/backend` — Express + WebSocket server, git analysis, Claude AI, TTS
- `packages/frontend` — React + Vite app
- `packages/cli` — CLI entry point

## Commands

- `pnpm dev` — Start both backend and frontend
- `pnpm typecheck` — Type-check all packages
- `pnpm build` — Build all packages
- `pnpm --filter @interactive-reviewer/frontend build` — Build frontend only

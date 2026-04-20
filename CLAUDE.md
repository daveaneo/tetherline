# Tetherline

Stay tethered to your codebase. AI-narrated weekly code reviews with voice, visual architecture diagrams, and exportable presentations. Built to close the gap between you and code that's being written faster than you can absorb it.

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
pnpm --filter tetherline dev -- /path/to/git/repo
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
- `pnpm --filter @tetherline/frontend build` — Build frontend only

# Debug mode — let Claude review your local session

When you run the app locally (`pnpm dev`), a DEV-only recorder
captures every screen transition (phase / scope / skill / voice /
briefing / pocket) and POSTs a snapshot to a backend ingest. Both the
structured state AND a downscaled visual of the page are logged. The
result is one JSONL file Claude can tail to reconstruct your lived
experience in detail — no copy-pasting console output, no
screenshots to share.

## How to use

1. Run the app: `pnpm dev` (or just the frontend if backend is
   already up).
2. Use the app normally — speak, click, drill in, ask things.
3. When you want a review, ask Claude something like:
   > "Review my last session."

   Claude will tail `/tmp/tetherline-debug.jsonl` (and decode the
   embedded JPEG dataURLs as needed) and walk through what you
   actually saw and heard, transition by transition.

## What's captured per transition

Each JSONL line is one of two kinds, sharing the same `id`:

| Field | Source |
|---|---|
| `id` | unique transition id (timestamp+counter) |
| `reason` | which store changed (`session` / `audio` / `init`) |
| `phase` | `state.phase` (IDLE, ANALYZING, OVERVIEW, …) |
| `scope` | current diagram scope (`project`, `module/core`, …) |
| `briefingId` | active briefing if any |
| `skillName` + `skillNarrationExcerpt` | last skill result + first ~140 chars |
| `critiqueActiveIndex` | which ranked concern is active (critique only) |
| `voiceState` | `idle` / `hearing` / `listening` / `processing` / `speaking` |
| `toasts` | last 5 speech toasts |
| `comprehensionCount` | size of the comprehension map |
| `pocketActive` | deep-dive pocket open? |
| `domSnapshot` | small list of visible `[data-testid]`, headings, button labels |

Then a follow-up line `kind: 'visual'` (same `id`) carries a
downscaled JPEG (`dataUrl`, ~0.4× viewport, quality 0.6) so the
literal pixels are available too.

A transition only fires when the **key fields actually changed**
(phase / scope / skill / briefing / voiceState / pocket) — re-renders
that don't move the needle are deduped.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/dev/telemetry` | The recorder POSTs structural + visual snapshots here. |
| `POST /api/dev/telemetry/clear` | Truncate the log to start a fresh session. |

The `/api/dev/*` namespace is gated by `devGuard`, so this is never
reachable in production.

## Implementation

| Where | What |
|---|---|
| `packages/frontend/src/lib/debug-recorder.ts` | The recorder. Gated on `import.meta.env.DEV`; short-circuits in prod. |
| `packages/frontend/src/main.tsx` | Calls `startDebugRecorder()` after React renders (skipped in scene mode). |
| `packages/backend/src/routes/dev.ts` | The two telemetry routes appending JSONL to `/tmp/tetherline-debug.jsonl`. |

## Notes

- **Performance.** Visual captures are downscaled (0.4×) and JPEG-
  compressed (~0.6 quality). One visual at a time — overlapping
  captures are dropped, not queued. The structural beacon is always
  sent first and never blocked by the visual.
- **Transport.** `fetch(..., { keepalive: true })` (not `sendBeacon`)
  so payloads can exceed the 64KB beacon limit visuals can hit.
- **Privacy / git.** `/tmp/tetherline-debug.jsonl` is outside the
  repo and never committed. `.claude/` and `*.tsbuildinfo` are
  already gitignored.

## Clearing the log

```bash
curl -X POST http://localhost:3847/api/dev/telemetry/clear
# or just:
: > /tmp/tetherline-debug.jsonl
```

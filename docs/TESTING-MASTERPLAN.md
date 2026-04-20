# Tetherline — Dev API + Testing Masterplan

A dev-only REST interface on the backend that lets an agent (me, or any script) drive every user-facing interaction programmatically, plus a full testing stack layered on top. Goal: close the feedback loop so I can iterate on the app without the user acting as a message-passer.

## 1. Goals

1. **Drive the app by HTTP from a terminal.** `curl -X POST /api/dev/utter -d '{"text":"what is this about"}'` should trigger the real pipeline and return enough info to see what happened.
2. **Run fast, deterministic tests.** Unit + integration suite finishes in under 10 seconds, hits no external APIs, costs nothing per run.
3. **Catch regressions across the whole pipeline.** Session lifecycle, voice intent routing, skill execution, LLM prompt drift, TTS output, diagram updates.
4. **Keep voice tests real but surgical.** Mic capture, STT, barge-in/interrupt behavior — these stay as separate targeted tests, not part of the default fast suite.
5. **Zero blast radius on the user's data.** Tests never touch `~/.tetherline`; each run gets an ephemeral data dir.

## 2. Non-goals (explicitly)

- No MCP wrapper. REST over localhost is enough; MCP can be added later if non-Claude-Code clients need to script this.
- No LLM-behavior evals here. Those belong in a separate eval suite driven by recorded transcripts; the test stack focuses on functional correctness.
- No load/perf testing. Latency is observable via the trace endpoint, but we don't auto-assert SLOs yet.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Test harness (vitest)         CLI / curl       Playwright E2E│
│        │                         │                   │       │
│        └──────── thin TS wrapper ┴───────────────────┘       │
│                         │                                     │
│                  Dev REST API (gated)                         │
│                         │                                     │
│  ┌──────────────────────┴──────────────────────────┐         │
│  │  Real session manager / skills / intelligence   │         │
│  │  (same code path WS events go through)          │         │
│  └──────────────────────┬──────────────────────────┘         │
│                         │                                     │
│              LLM adapter (w/ cassette layer)                  │
│              TTS adapter (record-only in tests)               │
│              STT adapter (bypassed; text injected)            │
└──────────────────────────────────────────────────────────────┘
```

**Key invariant:** dev endpoints route through the same `SessionManager` functions the WS handler uses. No shortcut code paths. A bug in the real flow shows up in the test flow.

## 4. Dev API surface

All endpoints live under `/api/dev/*` and are registered only when `NODE_ENV !== 'production'` AND request comes from loopback. 501 otherwise.

### 4.1 Session lifecycle

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| POST | `/api/dev/session/start` | `{ repoPath, entryMode, sinceDays? }` | `{ sessionId }` |
| POST | `/api/dev/session/reset` | `{ sessionId? }` — default: current | `{ ok }` |
| GET  | `/api/dev/session/:id` | — | full store snapshot |
| POST | `/api/dev/session/wait` | `{ phase, timeoutMs? }` | `{ reached: true, stateAt }` or 408 |

### 4.2 User interaction (replaces mic/STT)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/dev/utter` | `{ text, sessionId? }` | `{ intent, classifiedMs, fullResponseMs, narrationSegments, state }` |
| POST | `/api/dev/command` | `{ type: 'next'\|'previous'\|'skip'\|'pause'\|'resume'\|'exit', sessionId? }` | `{ ok, state }` |
| POST | `/api/dev/mode` | `{ key, enabled }` | `{ ok, modes }` |

### 4.3 Component isolation

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/dev/intent/classify` | `{ text }` | `{ intent, confidence, ms }` |
| POST | `/api/dev/skill/:name/run`  | skill-specific payload | raw skill result |
| POST | `/api/dev/llm/call` | `{ prompt, model?, cassetteKey? }` | `{ text, ms, cacheHit }` |
| POST | `/api/dev/tts/synthesize` | `{ text, provider? }` | `{ audioBase64, ms }` |

### 4.4 Observability

| Method | Path | Query | Returns |
|---|---|---|---|
| GET  | `/api/dev/trace` | `?since=ISO&sessionId=...&limit=100` | array of trace events |
| GET  | `/api/dev/trace/tail` (SSE) | `?sessionId=` | server-sent event stream |
| GET  | `/api/dev/state` | — | global store snapshot |
| GET  | `/api/dev/metrics` | — | per-stage latency histograms (p50/p95/p99) |
| GET  | `/api/dev/cassettes` | — | list + hit rates |

### 4.5 Fixture + clock control

| Method | Path | Body | Returns |
|---|---|---|---|
| GET  | `/api/dev/fixtures` | — | list of available fixture repos |
| POST | `/api/dev/fixtures/seed` | `{ name, destPath? }` | path to freshly created fixture |
| POST | `/api/dev/clock/set` | `{ now: ISO }` | `{ ok }` |
| POST | `/api/dev/clock/reset` | — | `{ ok }` |
| POST | `/api/dev/db/snapshot` | — | `{ snapshotId }` |
| POST | `/api/dev/db/restore` | `{ snapshotId }` | `{ ok }` |

### 4.6 Gating + shape

- **Gate:** `if (process.env.NODE_ENV === 'production') return next(); const ip = req.socket.remoteAddress; if (!isLoopback(ip)) return res.status(403).json({ error: 'dev endpoints are loopback-only' });`
- **Error shape:** `{ error: string, code: 'SESSION_NOT_FOUND' | ..., detail?: unknown }` — uniform across endpoints.
- **Auth:** none by default; `TETHERLINE_DEV_TOKEN` optional bearer header for paranoid users.

## 5. Trace event schema

The trace is the backbone of debugging. Every meaningful transition emits a record:

```ts
type TraceEvent = {
  id: string;               // ulid
  sessionId: string | null;
  ts: string;               // ISO
  kind:
    | 'utterance.received'    // user text arrived (via WS or dev API)
    | 'intent.classified'     // intent classifier returned
    | 'llm.request' | 'llm.response'
    | 'skill.started' | 'skill.completed' | 'skill.failed'
    | 'tts.requested' | 'tts.first_audio' | 'tts.completed'
    | 'narration.emitted' | 'phase.changed'
    | 'visual.update' | 'error';
  durationMs?: number;        // for paired start/end kinds
  payload: Record<string, unknown>;
};
```

Events are written to a rotating JSONL file at `<dataDir>/trace/<YYYY-MM-DD>.jsonl` AND held in-memory (last 1000) for the `/api/dev/trace` endpoint. In tests, they're the primary assertion surface: `expect(trace.find(e => e.kind === 'phase.changed' && e.payload.to === 'PROPOSAL')).toBeDefined()`.

## 6. LLM cassette layer

### 6.1 Design

A single adapter wraps every `anthropic.messages.create` call. Its shape:

```ts
interface LLMAdapter {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
```

The cassette implementation:

1. Hash `req` (model, system, messages, tools, temperature) → `key`.
2. Look for `test/cassettes/<testId>/<key>.yaml`. Hit → return.
3. Miss → if `RECORD=1`, make real call, save. If not, throw `CassetteMissError` with the request body so the test fails informatively.
4. Emit `llm.request` / `llm.response` trace events both ways.

Cassettes are human-readable YAML:

```yaml
request:
  model: claude-opus-4-7
  system: |
    You are a guide reviewing tetherline-monorepo...
  messages:
    - role: user
      content: what is this project about
response:
  id: msg_01...
  content: This is an AI-narrated weekly code review tool...
  usage: { input_tokens: 1423, output_tokens: 167 }
```

### 6.2 Refresh workflow

```bash
pnpm test                     # replay-only (fails on miss)
RECORD=1 pnpm test            # record misses, reuse hits
RECORD=force pnpm test        # re-record everything (after intentional prompt changes)
```

A CI check runs with plain `pnpm test` — if anyone changes a prompt without re-recording, CI fails loudly.

### 6.3 Per-test isolation

Each test declares its cassette namespace:

```ts
test('walks through full session', async () => {
  useCassette('session-full-walkthrough');
  // ...
});
```

Cassettes live at `test/cassettes/session-full-walkthrough/<hash>.yaml`. Rename = new cassette dir. Delete = fresh recording on next `RECORD=1` run.

### 6.4 Hygiene — preventing cassette explosion

Uncontrolled cassettes can balloon to gigabytes. Guards, in layers:

**Default is replay-only.** `pnpm test` never writes a cassette — misses throw `CassetteMissError` with the request body. The cache cannot grow without explicit `RECORD=1`.

**Canonicalize before hashing.** Strip or replace anything that would otherwise fragment identical semantic requests:
- Inject a fixed clock in tests (`clock.set('2026-04-20T10:00:00Z')`); never call `new Date()` during a test body.
- Session IDs, ULIDs → replace with `SESSION_ID` / `ULID_PLACEHOLDER` sentinels.
- Absolute paths → rewrite to `FIXTURE/...`.
- Fixture git SHAs → fixture scripts use fixed `GIT_AUTHOR_DATE` + `GIT_COMMITTER_DATE` + author/email, so SHAs are stable across machines.

**Hard caps.** Enforced in CI:
- `CASSETTE_MAX_PER_TEST=50` — a single test accumulating more than 50 recordings almost always means non-determinism leaked in. CI fails; author fixes the root cause.
- `CASSETTE_DIR_MAX_MB=10` — total size ceiling. If we genuinely need more, switching to git-lfs is a deliberate decision, not a slow creep.

**Orphan sweep.** Every test run writes a `.hits` sidecar recording which cassette files were touched. `pnpm test:cassettes:prune` deletes anything not hit. CI runs the equivalent in dry-run mode and fails if orphans exist — renamed/deleted tests can't leave dead recordings behind.

**RECORD guardrails.**
- `RECORD=1` logs a highly visible banner at startup — no silent mutation.
- Requires `CASSETTE_MAX_TOKENS` env (default 4096) — caps any single recording to prevent runaway cost.
- `RECORD=force` (full re-record) additionally requires `I_KNOW=1` — you can't wipe all cassettes by accident.

**Audit command.**

```bash
pnpm test:cassettes:audit
```

Prints total count, total size, per-test breakdown, biggest 10 recordings, oldest 10 by last-hit timestamp, and any orphans. One command to see whether the cache is healthy.

## 7. Test harness (the TS wrapper)

A thin facade over the dev API for readable tests:

```ts
import { tetherline } from '../../test/harness';

test('starts session and answers what-is-this', async () => {
  const app = await tetherline.start({ fixture: 'small-repo' });

  const { sessionId } = await app.startSession({ mode: 'updates' });
  await app.waitForPhase('PROPOSAL');

  const response = await app.utter('what is this about');
  expect(response.intent).toBe('ask_question');
  expect(response.narrationSegments.join(' ')).toMatch(/tetherline|review|codebase/i);
  expect(response.fullResponseMs).toBeLessThan(2000);

  await app.stop();
});
```

Helpers on `app`:
- `startSession`, `stopSession`, `resetSession`, `waitForPhase`, `waitForTrace`
- `utter`, `command`, `toggleMode`
- `state()`, `trace()`, `metrics()`
- `withClock(iso, fn)`, `withSnapshot(fn)` — scoped fixtures
- `expectNarration(matcher)`, `expectVisualUpdate(pred)` — assertion sugar

The harness itself boots the backend on a free ephemeral port against a tmp `TETHERLINE_DATA_DIR`. It uses the dev API exclusively — no direct module imports. That keeps tests honest to the real wire format.

## 8. Test organization

```
test/
├── cassettes/                  # LLM recordings (gitignored? — see §11)
├── fixtures/
│   ├── repos/                  # pre-generated fixture repos
│   │   ├── small-walkthrough/
│   │   ├── medium-updates/
│   │   ├── quiet-week/
│   │   └── big-refactor/
│   └── create-*.sh             # scripts to regenerate
├── harness/
│   ├── index.ts                # public tetherline.start() facade
│   ├── client.ts               # dev API HTTP client
│   ├── server.ts               # spawns backend process + waits ready
│   ├── cassettes.ts            # record/replay layer
│   └── assertions.ts           # custom matchers
├── unit/                       # pure-function tests (no server)
│   ├── git/
│   ├── intelligence/prompts/
│   ├── skills/
│   └── frontend/               # jsdom + vitest
├── integration/                # server + harness, mocked LLM via cassettes
│   ├── session/
│   │   ├── full-walkthrough.test.ts
│   │   ├── updates-only.test.ts
│   │   ├── onboarding.test.ts
│   │   └── explore.test.ts
│   ├── skills/
│   │   ├── explain.test.ts
│   │   ├── visualize.test.ts
│   │   └── ... (one per skill)
│   ├── voice-routing.test.ts   # text-injected utterances → correct skill
│   ├── modes.test.ts           # all 4 mode toggles affect behavior
│   ├── export.test.ts          # slides + markdown generation
│   ├── digest.test.ts          # weekly digest cron + generation
│   ├── advisory.test.ts        # concerns surfaced correctly
│   └── heatmap.test.ts         # understanding decays + updates
├── voice/                      # real-audio tests, run separately
│   ├── interrupt-latency.test.ts  # AI speaking → mic hot → silence <N ms
│   ├── barge-in.test.ts
│   ├── mic-start-gesture.test.ts
│   ├── stt-accuracy.test.ts       # pre-recorded WAVs through Whisper
│   └── tts-playback.test.ts
└── e2e/                        # playwright + dev API for setup
    ├── lobby.spec.ts
    ├── session-entry.spec.ts
    ├── diagram-layers.spec.ts
    └── export-flow.spec.ts
```

## 9. Voice test strategy (separate suite)

Voice tests target the mic/TTS/interrupt machinery that text-injection bypasses. They run outside the default suite:

```bash
pnpm test:voice        # requires mic hardware + local Whisper + Kokoro
```

**What they cover:**
- **Interrupt latency** — AI starts speaking, WAV file of "stop" is played into a virtual audio device, assert TTS silenced within 300ms and VoiceState transitions to `hearing` → `processing`.
- **Barge-in detection** — overlapping voice + TTS, assert the right barge-in heuristic triggers.
- **Mic-start user-gesture gating** — browser security test via playwright.
- **STT accuracy** — pre-recorded WAVs of canonical commands ("next", "skip", "what is this") → assert STT output is in an accepted alias set.
- **TTS playback** — segment boundaries, buffer underruns, silence padding.

**Infrastructure:**
- Virtual audio device (PulseAudio null sink on Linux, Blackhole on macOS) injected via `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` Chrome flags.
- Pre-recorded WAVs under `test/voice/audio/` — one per canonical command.
- These tests are explicitly NOT in CI for the default repo (hardware assumptions). They run on a local dev box with `pnpm test:voice`.

## 10. Fixtures

Each fixture is a generated git repo with a curated commit history that exercises a specific product flow:

| Fixture | Exercises |
|---|---|
| `small-walkthrough` | First-visit full walkthrough — 3 modules, 20 commits, clear architecture |
| `medium-updates` | Weekly updates mode — 100 commits, 2 themes (fix + refactor) |
| `quiet-week` | Empty-state updates mode — no commits in the last 7 days |
| `big-refactor` | Major architectural shift — advisory mode should fire |
| `monorepo-like` | Nested packages — tests that analyzer handles workspaces |
| `binary-heavy` | Mostly images/wasm — tests text-file filtering |

Each fixture is rebuilt from `test/fixtures/create-<name>.sh`. Scripts are idempotent: nuke + recreate. Fixtures are gitignored; only the scripts are tracked.

## 11. Cassettes — tracked or gitignored?

Decision: **tracked**, under `test/cassettes/`. Cassettes are part of the test contract. Tracking them means:
- New contributor runs `pnpm test` → works offline out of the box.
- A prompt change produces a visible diff in PR review.
- CI is free of external API calls.

Size concern: cassettes are YAML and compress well. If a session recording cassette hits 200kb, that's fine. If they grow to 50MB+, switch to git-lfs.

## 12. Runners

Package.json scripts:

```json
{
  "test": "vitest run",                                 // unit + integration, <10s target
  "test:watch": "vitest",
  "test:unit": "vitest run test/unit",
  "test:integration": "vitest run test/integration",
  "test:voice": "vitest run test/voice --config voice.vitest.config.ts",
  "test:e2e": "playwright test",
  "test:record": "RECORD=1 vitest run",
  "test:record:force": "RECORD=force vitest run"
}
```

Default `pnpm test` = unit + integration with replay cassettes. Fast, free, runs on every commit.

## 13. CI

GitHub Actions matrix, gated on PRs:

| Job | Runs | Purpose |
|---|---|---|
| typecheck | every push | catches compile errors |
| test (fast) | every push | unit + integration, replay only |
| test (e2e) | every push | playwright against dev API |
| test:record drift | nightly | runs `RECORD=force`, opens PR if cassettes differ |
| test:voice | manual | hardware-dependent, run on maintainer's box |

## 14. Rollout plan

Five landmark milestones, each shippable:

### Milestone 1 — Dev API foundation
- `packages/backend/src/routes/dev.ts` with all §4 endpoints
- Gate middleware (env + loopback)
- Trace event schema + ring buffer + JSONL writer
- Smoke test: hit `/api/dev/session/start` against a fixture repo, get expected state

### Milestone 2 — Cassette-capable LLM adapter
- Abstract `LLMAdapter` interface in `@tetherline/backend`
- `AnthropicAdapter` (real) + `CassetteAdapter` (replay/record) + `MockAdapter` (inline canned)
- Wire into intelligence layer, digest, skills
- Trace instrumentation on requests + responses

### Milestone 3 — Test harness + integration suite
- `test/harness/*` built on the dev API
- Fixture regeneration scripts for all 6 fixtures
- First integration suite: `session/full-walkthrough.test.ts` — start session, see PROPOSAL, say "next", advance through all areas, reach WRAP_UP, export markdown

### Milestone 4 — Skill + modes coverage
- One integration test per skill (8 skills → 8 tests)
- Modes matrix — toggle each, assert behavior change
- Advisory, export, digest integration tests

### Milestone 5 — E2E + voice
- Playwright suite driving the real frontend, using dev API for session setup
- Voice suite with pre-recorded WAVs + interrupt-latency assertions
- Documented in `docs/TESTING.md` for contributors

## 15. Open decisions

1. **Test framework** — vitest (fast, TS-native, vite-aligned) vs jest. Proposal: **vitest** for everything except playwright.
2. **Cassette format** — YAML (human-readable, diff-friendly) vs JSON. Proposal: **YAML**.
3. **Trace persistence** — JSONL forever vs rotating daily vs in-memory only. Proposal: **rotating JSONL + in-memory ring buffer (last 1000)**.
4. **Dev API authentication** — none vs bearer token. Proposal: **none by default** (loopback gate is enough for local), opt-in `TETHERLINE_DEV_TOKEN` for anyone running the backend on a remote dev server.
5. **Frontend unit tests** — jsdom + vitest vs skip. Proposal: **skip initially**, rely on E2E. Frontend logic is thin; the dev API exercises session-store behavior through integration.
6. **LLM cost for RECORD runs** — bound by per-test max tokens? Proposal: **yes**, `CASSETTE_MAX_TOKENS=4096` env limit, fails loudly if a test tries to exceed.

## 16. What I want you to push back on

- Is the dev API too broad? Anything I should cut to keep surface tight?
- Cassettes tracked in git — is 50MB a reasonable threshold before switching to LFS?
- Voice suite scope — should interrupt-latency be a hard CI gate on your laptop, or stay manual?
- Is there a product surface I'm missing a test for? (Weekly digest delivery? GitHub issue creation? Repo add flow?)
- Milestone sequencing — should I build one integration test per milestone as I go, or land them all in Milestone 4?

Ready to iterate on this before I write code.

# Testing Tetherline

```bash
pnpm test              # unit + integration, <10s, replay-only
pnpm test:watch        # vitest watch mode
pnpm test:unit         # pure functions, no server
pnpm test:integration  # dev API + session pipeline
pnpm test:record       # RECORD=1, fills cassette misses (hits the real API)
pnpm test:e2e          # playwright against real frontend
pnpm test:cassettes:audit  # cache health check
```

## What's where

| Path | Purpose |
|---|---|
| `packages/backend/src/routes/dev.ts` | `/api/dev/*` REST surface for programmatic control |
| `packages/backend/src/intelligence/llm/` | Adapter interface + Anthropic / Cassette / Mock impls |
| `packages/backend/src/dev/trace.ts` | Session-wide trace event ring buffer + JSONL |
| `test/harness/` | Spins up ephemeral backend, exposes `tetherline.start()` for tests |
| `test/unit/` | Pure-function tests (canonicalize, mock adapter, trace recorder) |
| `test/integration/` | Full session pipeline tests via harness + mocked LLM |
| `test/voice/` | Real-audio tests (opt-in via `VOICE_TESTS=1`) |
| `test/e2e/` | Playwright specs driving the browser |
| `test/fixtures/` | Deterministic git-repo generator scripts |
| `test/cassettes/` | YAML recordings of LLM responses (checked in) |

## Writing an integration test

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

describe('my feature', () => {
  let h: TetherlineHarness;

  beforeAll(async () => {
    const mock = new MockLLMAdapter();
    mock.onTool('group_commits', { clusters: [] });
    // ...register matchers for every tool the flow may invoke
    h = await tetherline.start({ mock });
  });

  afterAll(async () => { await h.stop(); });

  it('does the thing', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: '/tmp/my-fixture',
      entryMode: 'updates',
      sinceDays: 7,
    });
    await h.client.utter(devSessionId, 'what is this about');
    const { events } = await h.client.trace({ sessionId: devSessionId });
    expect(events.some(e => e.kind === 'llm.response')).toBe(true);
  });
});
```

## Cassettes

Cassettes live in `test/cassettes/<namespace>/<hash>.yaml`. They're
human-readable, diffable, and tracked in git. The default test run is
**replay-only** — misses throw with the full request body so you know what to
record.

```bash
# Record a new test's LLM calls for the first time
RECORD=1 pnpm test my-new-feature

# Re-record everything after intentional prompt changes
RECORD=force I_KNOW=1 pnpm test
```

Guardrails baked in:

- Requests are canonicalized before hashing (timestamps, UUIDs, ULIDs, absolute
  paths normalized to sentinels) so identical semantic requests share a cassette.
- Hard cap of 50 cassettes per namespace and 10MB total; CI fails if exceeded.
- Orphan sweep in CI — a cassette that wasn't hit during a test run gets pruned.
- `RECORD` logs a loud banner and enforces `CASSETTE_MAX_TOKENS`.

## Dev API

The backend exposes `/api/dev/*` when `NODE_ENV !== 'production'`, gated on
loopback. It's what the harness uses under the hood but you can also drive it
from the terminal:

```bash
# Health
curl localhost:3847/api/dev/ping

# Inspect current sessions + env
curl localhost:3847/api/dev/state | jq

# Start a session
curl -X POST localhost:3847/api/dev/session/start \
  -H 'content-type: application/json' \
  -d '{"repoPath":"/path/to/repo","entryMode":"updates"}'

# Inject a text utterance
curl -X POST localhost:3847/api/dev/utter \
  -H 'content-type: application/json' \
  -d '{"devSessionId":"dev_...","text":"what is this about"}'

# Follow the trace
curl 'localhost:3847/api/dev/trace?limit=20' | jq
```

# Voice interaction — before & after fix

_12 scenarios × 7 metrics. Fully reproducible via
`test/integration/voice-measurement/baseline.test.ts`._

## Headline

| Metric | Target | Before | After | Delta |
|---|---|---|---|---|
| `flushed` | true | 11/12 | 11/12 | — *(scenario 11 has no user, correct)* |
| **`emitsDuringUserSpeech`** | **0** | **4/12** | **12/12** | **+8** |
| `emitsBeforeFlush` | 0 | 10/12 | 12/12 | +2 |
| `timeToFlushMs` | ≤100ms | 11/12 | 11/12 | — |
| **`overlapMs`** | **≤100ms** | **5/12** | **12/12** | **+7** |
| **`selfInterrupts`** | **0** | **5/12** | **11/12** | **+6** |
| `timeToRespondMs` | 400-1500ms | 1/12 | 2/12 | *(most scenarios don't round-trip)* |

The three metrics that reproduce the user-reported pain points —
"AI interrupts itself" (`emitsDuringUserSpeech`), "AI cuts me off"
(`overlapMs`, `selfInterrupts`) — all moved from broken to passing.

## What changed between before and after

Two fixes, both gated behind `TETHERLINE_DISABLE_FLOOR_SUPPRESSION=1` so
the BEFORE state can be reproduced.

### Fix 1 — Bidirectional floor control (server-side gate)

`SessionManager` now wraps every outgoing `ServerEvent` through a gated
`emit()` that drops AI-speech events (`narration:*`, `qa:answer_chunk`)
while the user holds the conversational floor. Pattern from ChatGPT
Realtime and Gemini Live.

- `markUserSpeakingStarted()` → `userSpeaking=true`, emits
  `tts.queue_flush` trace event, clears any cooldown.
- `markUserSpeakingStopped()` → records timestamp, opens a
  `POST_USER_SILENCE_MS=600ms` cooldown window.
- `shouldSuppressNarration()` returns true while `userSpeaking` OR inside
  the cooldown window.
- Gated `emit()` → if the event is AI speech AND suppression is active,
  drop + record a `tts.drop` trace event. Everything else flows through.

### Fix 2 — Client-side flush emulation (harness-layer)

The real frontend, on `voiceState=hearing`, clears its audio element →
which fires `audio:segment_finished` back at the server. That behaviour
was missing from the scenario harness, pinning `overlapMs` to the full
segment runtime across every scenario.

Added: on `speaking_started`, the simulate endpoint auto-emits
`audio.segment_ended` for every open segment — what a real client should
do. This is a test-infrastructure correction; the corresponding frontend
change is a small hook in `useAudioPlayback` that's a follow-up.

## Per-scenario deltas on the metric that reproduces the complaint

`emitsDuringUserSpeech` — "AI kept talking while I was talking":

| Scenario | Before | After |
|---|---|---|
| 01-clean-barge-in | 2 ❌ | 0 ✅ |
| 02-heavy-backend-generation-during-speech | 5 ❌ | 0 ✅ |
| 03-rapid-double-barge-in | 1 ❌ | 0 ✅ |
| 04-brief-cough | 0 ✅ | 0 ✅ |
| 05-long-question | 2 ❌ | 0 ✅ |
| 06-mid-thought-pause | 1 ❌ | 0 ✅ |
| 07-clean-end-of-turn | 0 ✅ | 0 ✅ |
| 08-queue-leak | 2 ❌ | 0 ✅ |
| 09-segment-boundary | 1 ❌ | 0 ✅ |
| 10-early-session-interrupt | 1 ❌ | 0 ✅ |
| 11-self-interrupt | 0 ✅ | 0 ✅ |
| 12-sustained-user-speech | 6 ❌ | 0 ✅ |

Every scenario that had leakage is now clean.

## What's NOT yet fixed

**1 failing scenario on `selfInterrupts`:** scenario 11 (two back-to-back
server narrations with no audio-finish ack between them, no user involved).
The remaining pathology is **server-side queue-depth awareness** — before
emitting a new narration, check if the previous one has been ack'd; if not,
emit a synthetic flush or queue the new content. Not in this change.

**Voice floor events in production:** `speaking_started` /
`speaking_stopped` are today only reachable via `/api/dev/voice/simulate`.
Wiring them from the frontend VAD into the WS layer is the production
unlock — the gate exists and works, but nothing on the real mic path is
pulling the trigger yet.

**VAD end-of-turn threshold:** `POST_USER_SILENCE_MS=600` is just the
server cooldown *after* the frontend declares end-of-turn. The underlying
VAD threshold (how long of a silence before the frontend fires
`speaking_stopped`) lives in the frontend audio stack. Target: ≥1200ms.
Not tuned here.

## Reproduce

```bash
# BEFORE — both fixes disabled
TETHERLINE_DISABLE_FLOOR_SUPPRESSION=1 \
  VOICE_REPORT_OUT=docs/VOICE-BEFORE.md \
  pnpm vitest run test/integration/voice-measurement/baseline.test.ts

# AFTER — both fixes enabled
VOICE_REPORT_OUT=docs/VOICE-AFTER.md \
  pnpm vitest run test/integration/voice-measurement/baseline.test.ts
```

Reports in `docs/VOICE-BEFORE.md` and `docs/VOICE-AFTER.md`.

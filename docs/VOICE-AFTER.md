# Voice interaction — after measurement

_Generated 2026-04-21T15:33:45.907Z — 12 scenarios._

## Legend

| Metric | Target | Why it matters |
|---|---|---|
| `timeToFlushMs` | ≤100ms | User-visible lag between "I started talking" and "AI stopped". |
| `emitsDuringUserSpeech` | 0 | Server kept generating while user held the floor. |
| `emitsBeforeFlush` | 0 | Queue leak: narration emitted between user-start and queue-clear. |
| `timeToRespondMs` | 400-1500ms | Too fast = cut-off. Too slow = laggy. |
| `selfInterrupts` | 0 | AI started a new segment before the old one ended. |
| `overlapMs` | ≤100ms | How long AI audio + user audio overlapped. |
| `flushed` | true | Did the server clear its queue at all on user speech? |

## Per-scenario results

| # | Scenario | Flush | To-Flush | During | Leaks | To-Respond | Self-int | Overlap |
|---|---|---|---|---|---|---|---|---|
| 01-clean-barge-in | AI is mid-segment, user barges in with a question. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 02-heavy-backend-generation-during-speech | Backend streams 5 narration segments while user is speaking. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 03-rapid-double-barge-in | User interrupts, AI pauses, user immediately says another th | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 04-brief-cough | User coughs / says "hmm" for <200ms mid-narration. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 701ms ✅ | 0 ✅ | 0ms ✅ |
| 05-long-question | User interrupts with a full multi-second question. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 06-mid-thought-pause | User speaks, pauses 900ms mid-thought, continues. AI must no | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 07-clean-end-of-turn | User asks a full question then goes silent; AI should respon | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 803ms ✅ | 0 ✅ | 0ms ✅ |
| 08-queue-leak | Backend emits 3 narrations back-to-back, user interrupts aft | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 09-segment-boundary | User starts speaking exactly as segment N ends / N+1 starts. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 10-early-session-interrupt | User barges in before the greeting finishes. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 11-self-interrupt | Backend emits two narrations with no segment_finished betwee | ❌ | —ms — | 0 ✅ | 0 ✅ | —ms — | 1 ❌ | 0ms ✅ |
| 12-sustained-user-speech | User speaks for 3 seconds continuously. Backend keeps trying | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |

## Aggregate

| Metric | Pass rate |
|---|---|
| flushed | 11/12 |
| timeToFlushMs | 11/12 |
| emitsDuringUserSpeech | 12/12 |
| emitsBeforeFlush | 12/12 |
| timeToRespondMs | 2/12 |
| selfInterrupts | 11/12 |
| overlapMs | 12/12 |

## Scenarios

### 01-clean-barge-in
_Does the AI stop emitting narration the moment user voice begins?_

AI is mid-segment, user barges in with a question.

### 02-heavy-backend-generation-during-speech
_Does the gate catch a burst of server-side generation during the floor?_

Backend streams 5 narration segments while user is speaking.

### 03-rapid-double-barge-in
_Does the gate handle back-to-back interrupts without leaks in between?_

User interrupts, AI pauses, user immediately says another thing.

### 04-brief-cough
_Short involuntary sounds should gate briefly but let AI resume quickly._

User coughs / says "hmm" for <200ms mid-narration.

### 05-long-question
_Long user speech — gate must hold the whole time, release only after silence._

User interrupts with a full multi-second question.

### 06-mid-thought-pause
_Can the gate treat a pause as temporary rather than end-of-turn?_

User speaks, pauses 900ms mid-thought, continues. AI must not jump in.

### 07-clean-end-of-turn
_Timing: AI responds in 400-1500ms after user stops._

User asks a full question then goes silent; AI should respond after cooldown.

### 08-queue-leak
_Do queued narrations leak through after the floor transfer?_

Backend emits 3 narrations back-to-back, user interrupts after the first.

### 09-segment-boundary
_Edge case — floor transfer right at the hand-off._

User starts speaking exactly as segment N ends / N+1 starts.

### 10-early-session-interrupt
_Floor control active from the first moment of a session?_

User barges in before the greeting finishes.

### 11-self-interrupt
_AI interrupting itself (no user involved)._

Backend emits two narrations with no segment_finished between them.

### 12-sustained-user-speech
_Does the gate hold for a long sustained floor?_

User speaks for 3 seconds continuously. Backend keeps trying to emit.

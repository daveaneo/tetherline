# Voice interaction — before measurement

_Generated 2026-04-20T23:45:55.155Z — 10 scenarios._

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
| 01-clean-barge-in | AI is mid-segment, user barges in with a question. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 186ms ⚠️ |
| 02-rapid-double-barge-in | User interrupts, AI pauses, user immediately says another th | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 205ms ⚠️ |
| 03-brief-cough | User coughs / says "hmm" for <300ms mid-narration. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 182ms ⚠️ |
| 04-long-question | User interrupts with a full question. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 1353ms ❌ |
| 05-mid-thought-pause | User speaks, pauses 900ms mid-thought, continues. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 983ms ✅ | 0 ✅ | 0ms ✅ |
| 06-clean-end-of-turn | User asks a full question then goes silent. | ✅ | 0ms ✅ | 2 ❌ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ |
| 07-queue-leak | Server emits 3 narration segments back-to-back, user interru | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 2 ❌ | 183ms ⚠️ |
| 08-segment-boundary | User starts speaking exactly as segment N ends / N+1 starts. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 205ms ⚠️ |
| 09-early-session-interrupt | User barges in before greeting finishes. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 183ms ⚠️ |
| 10-self-interrupt | Server emits two narration events with no segment_ended betw | ❌ | —ms — | 0 ✅ | 0 ✅ | —ms — | 1 ❌ | 0ms ✅ |

## Aggregate

| Metric | Pass rate |
|---|---|
| flushed | 9/10 |
| timeToFlushMs | 9/10 |
| emitsDuringUserSpeech | 9/10 |
| emitsBeforeFlush | 10/10 |
| timeToRespondMs | 1/10 |
| selfInterrupts | 8/10 |
| overlapMs | 3/10 |

## Scenarios

### 01-clean-barge-in
_Can the AI stop speaking quickly when the user takes over?_

AI is mid-segment, user barges in with a question.

### 02-rapid-double-barge-in
_Does the AI lock into responding to the first interrupt before the second arrives?_

User interrupts, AI pauses, user immediately says another thing.

### 03-brief-cough
_Short involuntary sounds should NOT derail the AI._

User coughs / says "hmm" for <300ms mid-narration.

### 04-long-question
_AI should cut over to answering the question, not finish old narration._

User interrupts with a full question.

### 05-mid-thought-pause
_AI should wait, not interpret the pause as end-of-turn._

User speaks, pauses 900ms mid-thought, continues.

### 06-clean-end-of-turn
_How fast does the AI respond? 400-1500ms is the target._

User asks a full question then goes silent.

### 07-queue-leak
_Do queued segments leak through after the user has taken the floor?_

Server emits 3 narration segments back-to-back, user interrupts after the first.

### 08-segment-boundary
_Edge case — transition boundary._

User starts speaking exactly as segment N ends / N+1 starts.

### 09-early-session-interrupt
_Interrupt-handling active from the first moment of a session?_

User barges in before greeting finishes.

### 10-self-interrupt
_AI interrupting ITSELF — no user input involved._

Server emits two narration events with no segment_ended between them.

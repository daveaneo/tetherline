# Voice interaction — after-fix measurement

_Generated 2026-06-10T19:17:44.318Z — 15 scenarios._

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
| `ackDeliveredMs` | ≤2000ms | The spoken ack must SURVIVE the floor gate (held + released, not dropped). |

## Per-scenario results

| # | Scenario | Flush | To-Flush | During | Leaks | To-Respond | Self-int | Overlap | Ack |
|---|---|---|---|---|---|---|---|---|---|
| 01-clean-barge-in | AI is mid-segment, user barges in with a question. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ | —ms ❌ |
| 02-heavy-backend-generation-during-speech | Backend streams 5 narration segments while user is speaking. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ | —ms ❌ |
| 03-rapid-double-barge-in | User interrupts, AI pauses, user immediately says another th | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ | —ms ❌ |
| 04-brief-cough | User coughs / says "hmm" for <200ms mid-narration. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 702ms ✅ | 0 ✅ | 0ms ✅ | —ms — |
| 05-long-question | User interrupts with a full multi-second question. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 1ms ✅ | —ms ❌ |
| 06-mid-thought-pause | User speaks, pauses 900ms mid-thought, continues. AI must no | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 620ms ✅ | 0 ✅ | 0ms ✅ | 822ms ✅ |
| 07-clean-end-of-turn | User asks a full question then goes silent; AI should respon | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 620ms ✅ | 0 ✅ | 0ms ✅ | 772ms ✅ |
| 08-queue-leak | Backend emits 3 narrations back-to-back, user interrupts aft | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ | —ms — |
| 09-segment-boundary | User starts speaking exactly as segment N ends / N+1 starts. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ | —ms ❌ |
| 10-early-session-interrupt | User barges in before the greeting finishes. | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ | —ms — |
| 11-self-interrupt | Backend emits two narrations with no segment_finished betwee | ❌ | —ms — | 0 ✅ | 0 ✅ | —ms — | 1 ❌ | 0ms ✅ | —ms — |
| 12-sustained-user-speech | User speaks for 3 seconds continuously. Backend keeps trying | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | —ms — | 0 ✅ | 0ms ✅ | —ms ❌ |
| 13-ack-survives-floor | User asks a question; the spoken ack lands inside the post-s | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 620ms ✅ | 0 ✅ | 0ms ✅ | 569ms ✅ |
| 14-superseded-turn-stays-silent | User pauses mid-thought (segmented utterance) then keeps tal | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 1577ms ⚠️ | 0 ✅ | 0ms ✅ | 1525ms ✅ |
| 15-briefing-survives-floor | User asks a cache-fast briefing query ("what is this project | ✅ | 0ms ✅ | 0 ✅ | 0 ✅ | 620ms ✅ | 0 ✅ | 0ms ✅ | —ms ❌ |

## Aggregate

| Metric | Pass rate |
|---|---|
| flushed | 14/15 |
| timeToFlushMs | 14/15 |
| emitsDuringUserSpeech | 15/15 |
| emitsBeforeFlush | 15/15 |
| timeToRespondMs | 5/15 |
| selfInterrupts | 14/15 |
| overlapMs | 15/15 |
| ackDeliveredMs | 4/15 |

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

### 13-ack-survives-floor
_Is the ack HELD and delivered once the floor opens — not dropped? (Live bug 2026-06-09: tts.drop post_user_silence ate every ack.)_

User asks a question; the spoken ack lands inside the post-silence window.

### 14-superseded-turn-stays-silent
_Held narration from a superseded turn never plays into the user's continued sentence._

User pauses mid-thought (segmented utterance) then keeps talking — the held first turn is discarded.

### 15-briefing-survives-floor
_Is the DIRECT-RESPONSE briefing HELD and delivered — not dropped like a proactive briefing? (Live bug 2026-06-10: the answer the user asked for was swallowed by post_user_silence.)_

User asks a cache-fast briefing query ("what is this project about") inside the post-silence window.

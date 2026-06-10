/**
 * Voice interaction scenarios. Each encodes a specific interruption pattern
 * as a timeline of events against the backend. The harness runs each scenario
 * against a fresh session, captures the voice trace, and computes objective
 * metrics.
 *
 * These scenarios are designed to actively stress the floor-control gate —
 * they put the backend in a position where it *wants to speak* right when the
 * user has taken the floor, so we can measure what the gate actually does.
 */
import type { DevClient } from '../../harness/client.js';

export interface ScenarioStep {
  kind: 'speaking_started' | 'speaking_stopped' | 'utterance' | 'segment_started'
      | 'segment_finished' | 'server_narration' | 'wait';
  /** Milliseconds to wait before this step (relative to previous step). */
  delayMs: number;
  /** Arbitrary payload — text for utterance/server_narration, segmentId for segment events. */
  payload?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  description: string;
  steps: ScenarioStep[];
  whatItTests: string;
}

/** 12 scenarios covering every interruption class + self-interrupt pathology. */
export const SCENARIOS: Scenario[] = [
  {
    id: '01-clean-barge-in',
    description: 'AI is mid-segment, user barges in with a question.',
    whatItTests: 'Does the AI stop emitting narration the moment user voice begins?',
    steps: [
      { kind: 'server_narration', delayMs: 0,    payload: { text: 'The payments module handles capture and idempotency.' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's1' } },
      { kind: 'speaking_started', delayMs: 500 },
      // Backend "wants to say more" mid-barge-in — gate must drop these.
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'Here is more about retry handling.' } },
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'And another thing about idempotency keys.' } },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'wait, what is idempotency' } },
      { kind: 'speaking_stopped', delayMs: 100 },
      { kind: 'segment_finished', delayMs: 50,   payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '02-heavy-backend-generation-during-speech',
    description: 'Backend streams 5 narration segments while user is speaking.',
    whatItTests: 'Does the gate catch a burst of server-side generation during the floor?',
    steps: [
      { kind: 'speaking_started', delayMs: 0 },
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'First segment during user speech.' } },
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'Second segment during user speech.' } },
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'Third segment during user speech.' } },
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'Fourth segment during user speech.' } },
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'Fifth segment during user speech.' } },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'actually show me the ledger' } },
      { kind: 'speaking_stopped', delayMs: 120 },
    ],
  },
  {
    id: '03-rapid-double-barge-in',
    description: 'User interrupts, AI pauses, user immediately says another thing.',
    whatItTests: 'Does the gate handle back-to-back interrupts without leaks in between?',
    steps: [
      { kind: 'server_narration', delayMs: 0,    payload: { text: 'Looking at the architecture…' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's1' } },
      { kind: 'speaking_started', delayMs: 400 },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'skip' } },
      { kind: 'speaking_stopped', delayMs: 120 },
      { kind: 'segment_finished', delayMs: 40,   payload: { segmentId: 's1' } },
      // Backend tries to respond to "skip" — gate must still suppress because
      // we're within POST_USER_SILENCE_MS of speaking_stopped.
      { kind: 'server_narration', delayMs: 100,  payload: { text: 'Ok, skipping.' } },
      // User speaks again mid-cooldown
      { kind: 'speaking_started', delayMs: 50 },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'actually tell me about core' } },
      { kind: 'speaking_stopped', delayMs: 120 },
    ],
  },
  {
    id: '04-brief-cough',
    description: 'User coughs / says "hmm" for <200ms mid-narration.',
    whatItTests: 'Short involuntary sounds should gate briefly but let AI resume quickly.',
    steps: [
      { kind: 'server_narration', delayMs: 0,    payload: { text: 'This part is interesting…' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's1' } },
      { kind: 'speaking_started', delayMs: 700 },
      { kind: 'speaking_stopped', delayMs: 180 },
      // After 700ms, AI should be allowed to continue.
      { kind: 'server_narration', delayMs: 700,  payload: { text: 'As I was saying…' } },
      { kind: 'segment_finished', delayMs: 50,   payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '05-long-question',
    description: 'User interrupts with a full multi-second question.',
    whatItTests: 'Long user speech — gate must hold the whole time, release only after silence.',
    steps: [
      { kind: 'server_narration', delayMs: 0,    payload: { text: 'The ledger keeps a rolling snapshot.' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's1' } },
      { kind: 'speaking_started', delayMs: 300 },
      // Simulate backend trying to speak MULTIPLE times during the user's turn
      { kind: 'server_narration', delayMs: 300,  payload: { text: 'One interjection the gate should drop.' } },
      { kind: 'server_narration', delayMs: 400,  payload: { text: 'Another interjection the gate should drop.' } },
      { kind: 'utterance',        delayMs: 500,  payload: { text: 'but how does double entry bookkeeping actually work here' } },
      { kind: 'speaking_stopped', delayMs: 150 },
      { kind: 'segment_finished', delayMs: 30,   payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '06-mid-thought-pause',
    description: 'User speaks, pauses 900ms mid-thought, continues. AI must not jump in.',
    whatItTests: 'Can the gate treat a pause as temporary rather than end-of-turn?',
    steps: [
      { kind: 'speaking_started', delayMs: 0 },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'so' } },
      { kind: 'speaking_stopped', delayMs: 200 },
      // During the "pause," backend tries to jump in — must be blocked by the
      // POST_USER_SILENCE_MS cooldown.
      { kind: 'server_narration', delayMs: 300,  payload: { text: 'Let me tell you about X.' } },
      // 900ms total pause — still within a thought, not end of turn.
      { kind: 'speaking_started', delayMs: 600 },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'tell me about the architecture' } },
      { kind: 'speaking_stopped', delayMs: 150 },
    ],
  },
  {
    id: '07-clean-end-of-turn',
    description: 'User asks a full question then goes silent; AI should respond after cooldown.',
    whatItTests: 'Timing: AI responds in 400-1500ms after user stops.',
    steps: [
      { kind: 'speaking_started', delayMs: 0 },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'tell me about the architecture' } },
      { kind: 'speaking_stopped', delayMs: 150 },
      // AI responds ~800ms after silence
      { kind: 'server_narration', delayMs: 800,  payload: { text: 'The architecture has three tiers.' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's1' } },
      { kind: 'segment_finished', delayMs: 500,  payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '08-queue-leak',
    description: 'Backend emits 3 narrations back-to-back, user interrupts after the first.',
    whatItTests: 'Do queued narrations leak through after the floor transfer?',
    steps: [
      { kind: 'server_narration', delayMs: 0,    payload: { text: 'Segment one.' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's1' } },
      { kind: 'speaking_started', delayMs: 200 },
      // Two more narrations arrive AFTER user started speaking — these must
      // be dropped, not leak.
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'Segment two — should be dropped.' } },
      { kind: 'server_narration', delayMs: 50,   payload: { text: 'Segment three — should be dropped.' } },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'stop' } },
      { kind: 'speaking_stopped', delayMs: 100 },
      { kind: 'segment_finished', delayMs: 30,   payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '09-segment-boundary',
    description: 'User starts speaking exactly as segment N ends / N+1 starts.',
    whatItTests: 'Edge case — floor transfer right at the hand-off.',
    steps: [
      { kind: 'server_narration', delayMs: 0,    payload: { text: 'Segment one.' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's1' } },
      { kind: 'segment_finished', delayMs: 800,  payload: { segmentId: 's1' } },
      { kind: 'server_narration', delayMs: 5,    payload: { text: 'Segment two.' } },
      { kind: 'segment_started',  delayMs: 5,    payload: { segmentId: 's2' } },
      { kind: 'speaking_started', delayMs: 2 },
      { kind: 'server_narration', delayMs: 80,   payload: { text: 'Segment three — dropped mid-barge.' } },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'hold on' } },
      { kind: 'speaking_stopped', delayMs: 120 },
      { kind: 'segment_finished', delayMs: 30,   payload: { segmentId: 's2' } },
    ],
  },
  {
    id: '10-early-session-interrupt',
    description: 'User barges in before the greeting finishes.',
    whatItTests: 'Floor control active from the first moment of a session?',
    steps: [
      { kind: 'server_narration', delayMs: 0,    payload: { text: 'Welcome to the project, let me show you around.' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 'g1' } },
      { kind: 'speaking_started', delayMs: 200 },
      { kind: 'server_narration', delayMs: 80,   payload: { text: 'More greeting dropped by gate.' } },
      { kind: 'utterance',        delayMs: 80,   payload: { text: 'skip the intro' } },
      { kind: 'speaking_stopped', delayMs: 100 },
      { kind: 'segment_finished', delayMs: 30,   payload: { segmentId: 'g1' } },
    ],
  },
  {
    id: '11-self-interrupt',
    description: 'Backend emits two narrations with no segment_finished between them.',
    whatItTests: 'AI interrupting itself (no user involved).',
    steps: [
      { kind: 'server_narration', delayMs: 0,    payload: { text: 'Segment one is playing.' } },
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's1' } },
      // Second narration fires while first is still playing
      { kind: 'server_narration', delayMs: 400,  payload: { text: 'Actually, let me tell you something different.' } },
      // s1 gets trampled — no segment_finished for it
      { kind: 'segment_started',  delayMs: 10,   payload: { segmentId: 's2' } },
      { kind: 'segment_finished', delayMs: 500,  payload: { segmentId: 's2' } },
    ],
  },
  {
    id: '12-sustained-user-speech',
    description: 'User speaks for 3 seconds continuously. Backend keeps trying to emit.',
    whatItTests: 'Does the gate hold for a long sustained floor?',
    steps: [
      { kind: 'speaking_started', delayMs: 0 },
      { kind: 'server_narration', delayMs: 200,  payload: { text: 'Interjection 1.' } },
      { kind: 'server_narration', delayMs: 400,  payload: { text: 'Interjection 2.' } },
      { kind: 'server_narration', delayMs: 400,  payload: { text: 'Interjection 3.' } },
      { kind: 'server_narration', delayMs: 400,  payload: { text: 'Interjection 4.' } },
      { kind: 'server_narration', delayMs: 400,  payload: { text: 'Interjection 5.' } },
      { kind: 'utterance',        delayMs: 100,  payload: { text: 'long sustained question here with lots of words' } },
      { kind: 'server_narration', delayMs: 400,  payload: { text: 'Interjection 6.' } },
      { kind: 'speaking_stopped', delayMs: 100 },
    ],
  },
  {
    id: '13-ack-survives-floor',
    description: 'User asks a question; the spoken ack lands inside the post-silence window.',
    whatItTests: 'Is the ack HELD and delivered once the floor opens — not dropped? (Live bug 2026-06-09: tts.drop post_user_silence ate every ack.)',
    steps: [
      { kind: 'speaking_started', delayMs: 0 },
      { kind: 'speaking_stopped', delayMs: 600 },
      // The utterance lands right after speech stops — the ack it triggers
      // is emitted well inside POST_USER_SILENCE_MS.
      { kind: 'utterance',        delayMs: 50,   payload: { text: 'what is the ledger module for' } },
      // Give the release timer room to fire and the emit to land.
      { kind: 'wait',             delayMs: 1500 },
    ],
  },
  {
    id: '14-superseded-turn-stays-silent',
    description: 'User pauses mid-thought (segmented utterance) then keeps talking — the held first turn is discarded.',
    whatItTests: 'Held narration from a superseded turn never plays into the user\'s continued sentence.',
    steps: [
      { kind: 'speaking_started', delayMs: 0 },
      { kind: 'speaking_stopped', delayMs: 400 },
      { kind: 'utterance',        delayMs: 50,   payload: { text: 'so about the payments area of the codebase' } },
      // User keeps talking before the 600ms window opens — supersedes the
      // held ack; nothing from that turn may ever play.
      { kind: 'speaking_started', delayMs: 200 },
      { kind: 'server_narration', delayMs: 100,  payload: { text: 'Interjection during continued thought.' } },
      { kind: 'speaking_stopped', delayMs: 600 },
      { kind: 'utterance',        delayMs: 50,   payload: { text: 'actually how does the payments retry logic work' } },
      { kind: 'wait',             delayMs: 1200 },
    ],
  },
];

export async function runScenario(
  client: DevClient,
  devSessionId: string,
  scenario: Scenario,
): Promise<void> {
  for (const step of scenario.steps) {
    if (step.delayMs > 0) await new Promise(r => setTimeout(r, step.delayMs));
    if (step.kind === 'wait') continue;
    await client.voiceSimulate(devSessionId, step.kind, step.payload ?? {});
  }
  await new Promise(r => setTimeout(r, 80));
}

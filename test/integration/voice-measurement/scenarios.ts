/**
 * Voice interaction scenarios. Each encodes a specific interruption pattern
 * as a timeline of events against the backend. The harness runs each scenario
 * against a fresh session, captures the voice trace, and computes objective
 * metrics.
 */
import type { DevClient } from '../../harness/client.js';

export interface ScenarioStep {
  kind: 'speaking_started' | 'speaking_stopped' | 'utterance' | 'segment_started'
      | 'segment_finished' | 'server_emit' | 'wait';
  /** Milliseconds to wait before this step (relative to previous step). */
  delayMs: number;
  /** Arbitrary payload — text for utterance, segmentId for segment events. */
  payload?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  description: string;
  /** Timeline of steps executed in order against the running session. */
  steps: ScenarioStep[];
  /** For context: what the scenario is meant to exercise. */
  whatItTests: string;
}

/**
 * The 10 core scenarios. Each tests a specific class of interruption /
 * self-interrupt pathology.
 *
 * Naming convention: numeric prefix keeps them ordered in reports.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: '01-clean-barge-in',
    description: 'AI is mid-segment, user barges in with a question.',
    whatItTests: 'Can the AI stop speaking quickly when the user takes over?',
    steps: [
      { kind: 'server_emit',       delayMs: 0,    payload: { text: 'The payments module handles capture and idempotency.' } },
      { kind: 'segment_started',   delayMs: 10,   payload: { segmentId: 's1' } },
      // 500ms into playback, user starts speaking
      { kind: 'speaking_started',  delayMs: 500 },
      // 80ms later, user's transcript is in
      { kind: 'utterance',         delayMs: 80,   payload: { text: 'wait, what is idempotency' } },
      { kind: 'speaking_stopped',  delayMs: 100 },
      // Client would normally stop the segment here — simulate via segment_ended
      { kind: 'segment_finished',     delayMs: 50,   payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '02-rapid-double-barge-in',
    description: 'User interrupts, AI pauses, user immediately says another thing.',
    whatItTests: 'Does the AI lock into responding to the first interrupt before the second arrives?',
    steps: [
      { kind: 'server_emit',       delayMs: 0,   payload: { text: 'Looking at the architecture, we see…' } },
      { kind: 'segment_started',   delayMs: 10,  payload: { segmentId: 's1' } },
      { kind: 'speaking_started',  delayMs: 400 },
      { kind: 'utterance',         delayMs: 80,  payload: { text: 'skip' } },
      { kind: 'speaking_stopped',  delayMs: 120 },
      { kind: 'segment_finished',     delayMs: 40,  payload: { segmentId: 's1' } },
      // 150ms later, user speaks again
      { kind: 'speaking_started',  delayMs: 150 },
      { kind: 'utterance',         delayMs: 80,  payload: { text: 'actually tell me about core' } },
      { kind: 'speaking_stopped',  delayMs: 120 },
    ],
  },
  {
    id: '03-brief-cough',
    description: 'User coughs / says "hmm" for <300ms mid-narration.',
    whatItTests: 'Short involuntary sounds should NOT derail the AI.',
    steps: [
      { kind: 'server_emit',       delayMs: 0,   payload: { text: 'This part is interesting…' } },
      { kind: 'segment_started',   delayMs: 10,  payload: { segmentId: 's1' } },
      { kind: 'speaking_started',  delayMs: 700 },
      { kind: 'speaking_stopped',  delayMs: 180 },
      { kind: 'segment_finished',     delayMs: 500, payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '04-long-question',
    description: 'User interrupts with a full question.',
    whatItTests: 'AI should cut over to answering the question, not finish old narration.',
    steps: [
      { kind: 'server_emit',       delayMs: 0,   payload: { text: 'The ledger keeps a rolling snapshot.' } },
      { kind: 'segment_started',   delayMs: 10,  payload: { segmentId: 's1' } },
      { kind: 'speaking_started',  delayMs: 300 },
      { kind: 'utterance',         delayMs: 1200, payload: { text: 'but how does double entry bookkeeping actually work here' } },
      { kind: 'speaking_stopped',  delayMs: 150 },
      { kind: 'segment_finished',     delayMs: 30,  payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '05-mid-thought-pause',
    description: 'User speaks, pauses 900ms mid-thought, continues.',
    whatItTests: 'AI should wait, not interpret the pause as end-of-turn.',
    steps: [
      { kind: 'speaking_started',  delayMs: 0 },
      { kind: 'utterance',         delayMs: 80,  payload: { text: 'so' } },
      { kind: 'speaking_stopped',  delayMs: 200 },
      // 900ms pause — within a thought, not end of turn
      { kind: 'speaking_started',  delayMs: 900 },
      { kind: 'utterance',         delayMs: 80,  payload: { text: 'tell me about the architecture' } },
      { kind: 'speaking_stopped',  delayMs: 150 },
    ],
  },
  {
    id: '06-clean-end-of-turn',
    description: 'User asks a full question then goes silent.',
    whatItTests: 'How fast does the AI respond? 400-1500ms is the target.',
    steps: [
      { kind: 'speaking_started',  delayMs: 0 },
      { kind: 'utterance',         delayMs: 80,  payload: { text: 'tell me about the architecture' } },
      { kind: 'speaking_stopped',  delayMs: 150 },
    ],
  },
  {
    id: '07-queue-leak',
    description: 'Server emits 3 narration segments back-to-back, user interrupts after the first.',
    whatItTests: 'Do queued segments leak through after the user has taken the floor?',
    steps: [
      { kind: 'server_emit',       delayMs: 0,   payload: { text: 'Segment one.' } },
      { kind: 'segment_started',   delayMs: 10,  payload: { segmentId: 's1' } },
      { kind: 'server_emit',       delayMs: 50,  payload: { text: 'Segment two.' } },
      { kind: 'server_emit',       delayMs: 50,  payload: { text: 'Segment three.' } },
      { kind: 'speaking_started',  delayMs: 300 },
      { kind: 'utterance',         delayMs: 80,  payload: { text: 'stop' } },
      { kind: 'speaking_stopped',  delayMs: 100 },
      { kind: 'segment_finished',     delayMs: 30,  payload: { segmentId: 's1' } },
    ],
  },
  {
    id: '08-segment-boundary',
    description: 'User starts speaking exactly as segment N ends / N+1 starts.',
    whatItTests: 'Edge case — transition boundary.',
    steps: [
      { kind: 'server_emit',       delayMs: 0,   payload: { text: 'Segment one.' } },
      { kind: 'segment_started',   delayMs: 10,  payload: { segmentId: 's1' } },
      { kind: 'segment_finished',     delayMs: 800, payload: { segmentId: 's1' } },
      { kind: 'server_emit',       delayMs: 5,   payload: { text: 'Segment two.' } },
      { kind: 'segment_started',   delayMs: 5,   payload: { segmentId: 's2' } },
      // User speaks right at the hand-off
      { kind: 'speaking_started',  delayMs: 2 },
      { kind: 'utterance',         delayMs: 80,  payload: { text: 'hold on' } },
      { kind: 'speaking_stopped',  delayMs: 120 },
      { kind: 'segment_finished',     delayMs: 30,  payload: { segmentId: 's2' } },
    ],
  },
  {
    id: '09-early-session-interrupt',
    description: 'User barges in before greeting finishes.',
    whatItTests: 'Interrupt-handling active from the first moment of a session?',
    steps: [
      { kind: 'server_emit',       delayMs: 0,   payload: { text: 'Welcome to the project, let me show you around.' } },
      { kind: 'segment_started',   delayMs: 10,  payload: { segmentId: 'g1' } },
      { kind: 'speaking_started',  delayMs: 200 },
      { kind: 'utterance',         delayMs: 80,  payload: { text: 'skip the intro' } },
      { kind: 'speaking_stopped',  delayMs: 100 },
      { kind: 'segment_finished',     delayMs: 30,  payload: { segmentId: 'g1' } },
    ],
  },
  {
    id: '10-self-interrupt',
    description: 'Server emits two narration events with no segment_ended between them.',
    whatItTests: 'AI interrupting ITSELF — no user input involved.',
    steps: [
      { kind: 'server_emit',       delayMs: 0,   payload: { text: 'Segment one is playing.' } },
      { kind: 'segment_started',   delayMs: 10,  payload: { segmentId: 's1' } },
      // Server fires a second narration while first is still going
      { kind: 'server_emit',       delayMs: 400, payload: { text: 'Actually, let me tell you something different.' } },
      { kind: 'segment_started',   delayMs: 10,  payload: { segmentId: 's2' } },
      // Neither segment gets a clean ended — s1 gets trampled
      { kind: 'segment_finished',     delayMs: 500, payload: { segmentId: 's2' } },
    ],
  },
];

/** Execute a scenario timeline against the given session. The scenario records
 *  simulated events with realistic delays so the trace timeline captures the
 *  ordering the backend actually sees. */
export async function runScenario(
  client: DevClient,
  devSessionId: string,
  scenario: Scenario,
): Promise<void> {
  for (const step of scenario.steps) {
    if (step.delayMs > 0) await new Promise(r => setTimeout(r, step.delayMs));

    if (step.kind === 'server_emit') {
      // Simulate a server-side narration emission via the real utterance path
      // — we use a harmless "resume" keyword to force a narration emit, then
      // record an explicit trace event. Direct approach: use the /api/dev/trace
      // ingestion by triggering an internal navigation event. Simpler: just
      // inject a fake trace event by invoking the ping endpoint + separate
      // emit — here we just use a dedicated simulate kind if you add one.
      // For now we approximate by asking the backend to say the current
      // briefing (emits narration:briefing via resume op).
      await client.utter(devSessionId, 'resume');
      continue;
    }
    if (step.kind === 'wait') continue;
    await client.voiceSimulate(devSessionId, step.kind, step.payload ?? {});
  }
  // Small settle window so late events land in the trace before we query.
  await new Promise(r => setTimeout(r, 80));
}

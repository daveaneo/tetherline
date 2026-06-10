/**
 * Phase-2 voice latency mechanics, end-to-end through the dev API:
 *  1. the instant ack speaks (as stream seq 0) while classification is
 *     still running — the user never sits in dead air;
 *  2. answer sentences are emitted INCREMENTALLY while the LLM stream is
 *     still producing (true token streaming, not chunked-after-the-fact);
 *  3. the hard sentence cap truncates at 4 (normal tier), appends the
 *     steering hook, and ABORTS the underlying LLM stream;
 *  4. a bare "tell me more" right after truncation re-asks the SAME
 *     question at the deep tier;
 *  5. skill narrations get the same cap + hook (post-hoc).
 *
 * NOTE: /api/dev/utter responds after a fixed 50ms tick (fire-and-forget
 * into the pipeline), so all timing assertions are anchored to EVENT
 * arrival times observed by polling, never to utter() resolution.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter, type LLMRequest } from '../../packages/backend/src/intelligence/llm/index.js';
import { STEERING_HOOK } from '../../packages/backend/src/session/answer-streamer.js';

const FIXTURE = '/tmp/tetherline-fixture-stream';
let h: TetherlineHarness;
let mock: MockLLMAdapter;

const Q_ACK = 'tell me everything important about the capture module internals';
const Q_STREAM = 'how does the streaming pipeline work in here';
const Q_SKILL = 'explain the capture area please';

const TEN_SENTENCES = Array.from({ length: 10 }, (_, i) =>
  `Sentence number ${i + 1} talks about the pipeline.`);
const DEEP_REPLY =
  'Deep sentence one explains the guard. Deep sentence two covers retries. ' +
  'Deep sentence three covers the store. Deep sentence four covers replay. ' +
  'Deep sentence five wraps up.';
const LONG_SKILL_NARRATION = Array.from({ length: 8 }, (_, i) =>
  `Skill narration sentence ${i + 1} describes the capture area.`).join(' ');
const ACK_REPLY = 'Capture is small. It guards retries.';

const CLASSIFY_DELAY_MS = 1200;

function msgText(req: LLMRequest): string {
  return JSON.stringify(req.messages);
}

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'capture', description: 'd', commitHashes: [], significance: 'minor', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'A multi-module fixture.', purpose: 'Stream test.', techStack: [], keyAreas: [], conceptualSteps: [{ icon: '🧱', title: 'a', description: 'd' }] });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'd' }] });
  m.onTool('summarize_files', { summaries: [] });

  // classify: explain-skill for Q_SKILL, otherwise 'none' (QA route).
  // The delay simulates real classifier latency so ack-beats-classifier
  // is a meaningful assertion.
  m.on(
    req => req.tool?.name === 'classify_intent' && msgText(req).includes(Q_SKILL),
    { toolInput: { skillName: 'explain', confidence: 0.95, params: { target: 'capture' } } },
    { delayMs: CLASSIFY_DELAY_MS },
  );
  m.on(
    req => req.tool?.name === 'classify_intent',
    { toolInput: { skillName: 'none', confidence: 0.8, params: {} } },
    { delayMs: CLASSIFY_DELAY_MS },
  );

  // Deep-tier re-ask (the unlock path) — must outrank the per-question
  // handlers below so the re-asked question answers long-form.
  m.on(
    req => !req.tool && req.system.includes('user asked for depth'),
    { text: DEEP_REPLY },
  );
  // Q_STREAM answers as a TIMED token stream: 10 sentences, 150ms apart.
  m.onTextStream(
    req => !req.tool && msgText(req).includes(Q_STREAM),
    TEN_SENTENCES.map(s => s + ' '),
    150,
  );
  m.on(req => !req.tool && msgText(req).includes(Q_ACK), { text: ACK_REPLY });
  // Everything else (incl. the explain skill's answerQuestion): a long
  // single-blob completion — exercises the post-hoc cap.
  m.on(req => !req.tool, { text: LONG_SKILL_NARRATION });
  return m;
}

async function settle(devSessionId: string) {
  await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'WRAP_UP', 'AREA_WALKTHROUGH'], 45_000);
  if ((await h.client.getSession(devSessionId)).state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    await new Promise(r => setTimeout(r, 100));
  }
}

type AnyEvent = { type: string; payload?: any };
type Chunk = { streamId: string; seq: number; text: string; isFinal: boolean };

function chunksOf(events: AnyEvent[]): Chunk[] {
  return events.filter(e => e.type === 'narration:stream_chunk').map(e => e.payload);
}

/** Poll events until `pred` matches a chunk; returns the chunk + arrival time. */
async function waitForChunk(
  devSessionId: string,
  since: number,
  pred: (c: Chunk) => boolean,
  timeoutMs = 10_000,
): Promise<{ chunk: Chunk; at: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const evs = (await h.client.events(devSessionId, since)).events as AnyEvent[];
    const found = chunksOf(evs).find(pred);
    if (found) return { chunk: found, at: Date.now() };
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('timed out waiting for chunk');
}

function countSentences(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  mock = buildMock();
  h = await tetherline.start({ mock });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('streaming voice pipeline — ack, token streaming, hard cap', () => {
  it('speaks an ack immediately; the answer follows after the slow classifier, on the same stream', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const startIdx = (await h.client.events(devSessionId)).events.length;

    const t0 = Date.now();
    void h.client.utter(devSessionId, Q_ACK);

    const ack = await waitForChunk(devSessionId, startIdx, c => c.seq === 0);
    expect(ack.at - t0, 'ack should arrive well before the 1200ms classifier').toBeLessThan(800);
    expect(ack.chunk.text.length).toBeGreaterThan(0);
    expect(ack.chunk.isFinal).toBe(false);

    const answer = await waitForChunk(devSessionId, startIdx, c => c.seq >= 1);
    expect(answer.at - ack.at, 'answer must trail the ack by ~the classifier delay').toBeGreaterThan(CLASSIFY_DELAY_MS - 400);
    expect(answer.chunk.streamId, 'ack and answer share one stream').toBe(ack.chunk.streamId);

    await waitForChunk(devSessionId, startIdx, c => c.isFinal);
    const all = chunksOf((await h.client.events(devSessionId, startIdx)).events as AnyEvent[]);
    expect(all.filter(c => c.seq >= 1).map(c => c.text).join(' ')).toBe(ACK_REPLY);
  }, 60_000);

  it('emits sentences incrementally, caps at 4, appends the hook, aborts the stream; "tell me more" re-asks deep', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const startIdx = (await h.client.events(devSessionId)).events.length;
    const abortsBefore = mock.getAbortedStreams().length;

    void h.client.utter(devSessionId, Q_STREAM);

    // Incremental emission: with 150ms between deltas, the first answer
    // sentence and the final hook are ~450ms+ apart. The old batch
    // behavior emitted everything in one synchronous burst (<50ms).
    const first = await waitForChunk(devSessionId, startIdx, c => c.seq >= 1);
    const final = await waitForChunk(devSessionId, startIdx, c => c.isFinal);
    expect(final.at - first.at, 'chunks must be spread over time (incremental), not burst').toBeGreaterThan(250);

    const all = chunksOf((await h.client.events(devSessionId, startIdx)).events as AnyEvent[]);
    const hook = all[all.length - 1];
    expect(hook.text).toBe(STEERING_HOOK);
    expect(hook.isFinal).toBe(true);

    // Spoken answer = chunks between ack (seq 0) and the hook: exactly 4 sentences.
    const spoken = all.filter(c => c.seq >= 1 && c.text !== STEERING_HOOK).map(c => c.text).join(' ');
    expect(countSentences(spoken)).toBe(4);
    expect(spoken).not.toContain('Sentence number 5');

    // The cap aborted the underlying LLM stream (token savings + CLI cap).
    expect(mock.getAbortedStreams().length).toBeGreaterThan(abortsBefore);

    // Truncation + bare "tell me more" → re-ask of the SAME question, deep
    // tier, no classifier round-trip.
    const callsBefore = mock.getCalls().length;
    const startIdx2 = (await h.client.events(devSessionId)).events.length;
    void h.client.utter(devSessionId, 'tell me more');
    await waitForChunk(devSessionId, startIdx2, c => c.isFinal);
    const all2 = chunksOf((await h.client.events(devSessionId, startIdx2)).events as AnyEvent[]);
    expect(all2[0]?.text).toBe('Sure, going deeper.');
    const body = all2.filter(c => c.seq >= 1).map(c => c.text).join(' ');
    expect(body).toContain('Deep sentence one');
    expect(body).not.toContain(STEERING_HOOK);
    const newCalls = mock.getCalls().slice(callsBefore);
    const reask = newCalls.find(r => !r.tool && msgText(r).includes(Q_STREAM));
    expect(reask, 're-ask must carry the truncated question').toBeTruthy();
    expect(newCalls.some(r => r.tool?.name === 'classify_intent')).toBe(false);
  }, 60_000);

  it('caps skill narrations post-hoc with the same hook', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const startIdx = (await h.client.events(devSessionId)).events.length;

    void h.client.utter(devSessionId, Q_SKILL);
    await waitForChunk(devSessionId, startIdx, c => c.isFinal);

    const evs = (await h.client.events(devSessionId, startIdx)).events as AnyEvent[];
    const all = chunksOf(evs);
    const hook = all[all.length - 1];
    expect(hook.text).toBe(STEERING_HOOK);
    expect(hook.isFinal).toBe(true);
    const spoken = all.filter(c => c.seq >= 1 && c.text !== STEERING_HOOK).map(c => c.text).join(' ');
    expect(countSentences(spoken)).toBeLessThanOrEqual(4);
    expect(spoken).not.toContain('sentence 8');
  }, 60_000);
});

/**
 * Floor-gate hold-and-release: the spoken ack (seq 0 of the turn stream)
 * must SURVIVE the post-user-silence window, not be dropped by it.
 *
 * Live bug 2026-06-09: the ack is emitted within ~300ms of the utterance —
 * always inside POST_USER_SILENCE_MS (600ms) — so emit()'s floor gate
 * dropped it (`tts.drop reason=post_user_silence`) and the user never
 * heard the ack, defeating its entire purpose.
 *
 * New contract:
 *  - current-turn stream chunks are HELD while the floor is closed
 *    (`tts.hold`), released IN ORDER when it opens (`tts.release`);
 *  - PROACTIVE greetings/briefings (session-start, tour-next) still DROP;
 *  - the user speaking again before release discards the held turn
 *    (`tts.discard_pending reason=superseded`) — a fresh ack is coming.
 *
 * Round 3 (live bug 2026-06-10): a DIRECT-RESPONSE briefing — the cache-fast
 * answer to "tell me about core" — is emitted as `narration:briefing` inside
 * the same silence window and was DROPPED (`tts.drop reason=post_user_silence`),
 * so the user's question got swallowed and he had to repeat himself. A briefing
 * whose id === the current turn's response briefing must be HELD like the ack.
 *
 * Known follow-up (documented, not yet covered): `narration:segment_ready`
 * emitted by command:next/skip during the window is the remaining member of
 * this swallowed-response class.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter, type LLMRequest } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-floor';
let h: TetherlineHarness;

const QUESTION = 'what does the capture module actually do in this codebase';
const ANSWER = 'Capture records audio. It buffers samples.';
const CLASSIFY_DELAY_MS = 1500;

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
  m.onTool('project_overview', { overview: 'A fixture.', purpose: 'Floor test.', techStack: [], keyAreas: [], conceptualSteps: [{ icon: '🧱', title: 'a', description: 'd' }] });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'd' }] });
  m.onTool('summarize_files', { summaries: [] });
  // Slow classifier: gives the test a deterministic window where ONLY the
  // ack exists on the turn stream.
  m.on(
    req => req.tool?.name === 'classify_intent',
    { toolInput: { skillName: 'none', confidence: 0.8, params: {} } },
    { delayMs: CLASSIFY_DELAY_MS },
  );
  m.on(req => !req.tool && msgText(req).includes(QUESTION), { text: ANSWER });
  m.on(req => !req.tool, { text: 'Generic reply sentence.' });
  return m;
}

/** Seed cache-fast briefings so "tell me about core" routes via the
 *  Navigator (push_named → deliverBriefing user_asked) with no LLM call —
 *  exactly the live fast path that got swallowed. */
function seedBriefings() {
  const base = { sourceHash: 'h', cachedAt: new Date().toISOString() };
  const repo = h.server.db.getBriefingRepo();
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'project', layer: 'project', title: 'fixture',
    opener: 'A fixture project with two modules, core and utils.',
    talkingPoints: [], children: ['module/core', 'module/utils'], parent: null,
    visualCue: { kind: 'none' }, estimatedSeconds: 10,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'module/core', layer: 'module', title: 'core',
    opener: 'Core records audio and buffers samples for the pipeline.',
    talkingPoints: [], children: [], parent: 'project',
    visualCue: { kind: 'diagram_focus', ref: 'core' }, estimatedSeconds: 10,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'module/utils', layer: 'module', title: 'utils',
    opener: 'Utils holds shared helpers used across the codebase.',
    talkingPoints: [], children: [], parent: 'project',
    visualCue: { kind: 'diagram_focus', ref: 'utils' }, estimatedSeconds: 10,
  });
}

async function settle(devSessionId: string) {
  await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'WRAP_UP', 'AREA_WALKTHROUGH'], 45_000);
  if ((await h.client.getSession(devSessionId)).state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    await new Promise(r => setTimeout(r, 100));
  }
}

type AnyEvent = { type: string; payload?: any };

function chunksOf(events: AnyEvent[]) {
  return events
    .filter(e => e.type === 'narration:stream_chunk')
    .map(e => e.payload as { streamId: string; seq: number; text: string; isFinal: boolean });
}

/** Trace kinds for this session since a given count offset. */
async function traceKinds(backendId: string) {
  const { events } = await h.client.trace({ sessionId: backendId, limit: 1000 });
  return events as Array<{ kind: string; payload: any }>;
}

async function backendIdOf(devSessionId: string): Promise<string> {
  const s = await h.client.getSession(devSessionId);
  return (s as any).backendId ?? (s as any).sessionId ?? '';
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('floor gate hold-and-release', () => {
  it('holds the ack while the floor is closed, releases it after the silence window, in order before the answer', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const backendId = await backendIdOf(devSessionId);
    const traceBefore = (await traceKinds(backendId)).length;
    const startIdx = (await h.client.events(devSessionId)).events.length;

    // User speaks, then the utterance lands (mic still inside the
    // post-silence window — the live-bug timing).
    await h.client.voiceSimulate(devSessionId, 'speaking_started');
    await h.client.voiceSimulate(devSessionId, 'speaking_stopped');
    await h.client.utter(devSessionId, QUESTION);

    // Within the 600ms window: the ack must be HELD, not dropped, and the
    // client must NOT have received it yet.
    await new Promise(r => setTimeout(r, 250));
    const midTrace = (await traceKinds(backendId)).slice(traceBefore);
    expect(midTrace.some(e => e.kind === 'tts.hold'), 'ack should trace tts.hold').toBe(true);
    expect(
      midTrace.some(e => e.kind === 'tts.drop' && (e.payload as any)?.eventType === 'narration:stream_chunk'),
      'turn chunks must not be dropped',
    ).toBe(false);
    const midChunks = chunksOf((await h.client.events(devSessionId, startIdx)).events as AnyEvent[]);
    expect(midChunks.filter(c => c.seq === 0)).toHaveLength(0);

    // After the window opens the held ack is released; the answer follows.
    const t0 = Date.now();
    let released = false;
    while (Date.now() - t0 < 5000) {
      const kinds = (await traceKinds(backendId)).slice(traceBefore);
      if (kinds.some(e => e.kind === 'tts.release')) { released = true; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(released, 'tts.release must fire after the silence window').toBe(true);

    // Wait for the full answer, then assert order: seq 0 arrived before seq 1+.
    const tFinal = Date.now();
    while (Date.now() - tFinal < 10_000) {
      const cs = chunksOf((await h.client.events(devSessionId, startIdx)).events as AnyEvent[]);
      if (cs.some(c => c.isFinal)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const all = chunksOf((await h.client.events(devSessionId, startIdx)).events as AnyEvent[]);
    const seq0Idx = all.findIndex(c => c.seq === 0);
    const seq1Idx = all.findIndex(c => c.seq >= 1);
    expect(seq0Idx, 'ack must be delivered').toBeGreaterThanOrEqual(0);
    expect(seq1Idx, 'answer must be delivered').toBeGreaterThanOrEqual(0);
    expect(seq0Idx, 'ack (seq 0) must precede answer chunks').toBeLessThan(seq1Idx);
    expect(all[seq0Idx].streamId).toBe(all[seq1Idx].streamId);
  }, 60_000);

  it('still DROPS non-turn narration (greetings) while the floor is closed', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const backendId = await backendIdOf(devSessionId);
    const traceBefore = (await traceKinds(backendId)).length;

    await h.client.voiceSimulate(devSessionId, 'speaking_started');
    await h.client.voiceSimulate(devSessionId, 'server_narration', { text: 'Proactive narration the user talked over.' });
    await h.client.voiceSimulate(devSessionId, 'speaking_stopped');

    const kinds = (await traceKinds(backendId)).slice(traceBefore);
    expect(kinds.some(e => e.kind === 'tts.drop' && (e.payload as any)?.eventType === 'narration:greeting')).toBe(true);
    expect(kinds.some(e => e.kind === 'tts.hold')).toBe(false);
  }, 60_000);

  it('discards the held turn when the user speaks again before release', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const backendId = await backendIdOf(devSessionId);
    const traceBefore = (await traceKinds(backendId)).length;
    const startIdx = (await h.client.events(devSessionId)).events.length;

    await h.client.voiceSimulate(devSessionId, 'speaking_started');
    await h.client.voiceSimulate(devSessionId, 'speaking_stopped');
    await h.client.utter(devSessionId, QUESTION);
    await new Promise(r => setTimeout(r, 150)); // ack now held
    await h.client.voiceSimulate(devSessionId, 'speaking_started'); // user talks again

    const kinds = (await traceKinds(backendId)).slice(traceBefore);
    expect(kinds.some(e => e.kind === 'tts.discard_pending')).toBe(true);

    // The stale ack never reaches the client — wait past the would-be
    // release window to prove it.
    await h.client.voiceSimulate(devSessionId, 'speaking_stopped');
    await new Promise(r => setTimeout(r, 900));
    const staleChunks = chunksOf((await h.client.events(devSessionId, startIdx)).events as AnyEvent[])
      // The superseding utterance's OWN turn may emit later; only chunks
      // belonging to the discarded turn count, identified via tts.hold.
      .filter(c => {
        const held = kinds.find(e => e.kind === 'tts.hold');
        return held && c.streamId === (held.payload as any)?.streamId && c.seq === 0;
      });
    expect(staleChunks).toHaveLength(0);
  }, 60_000);

  it('holds a direct-response briefing during the silence window and delivers it', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    seedBriefings();
    const backendId = await backendIdOf(devSessionId);
    const traceBefore = (await traceKinds(backendId)).length;
    const startIdx = (await h.client.events(devSessionId)).events.length;

    // "tell me about core" → Navigator push_named → deliverBriefing('user_asked')
    // → narration:briefing, emitted inside the 600ms post-silence window.
    await h.client.voiceSimulate(devSessionId, 'speaking_started');
    await h.client.voiceSimulate(devSessionId, 'speaking_stopped');
    await h.client.utter(devSessionId, 'tell me about core');

    // Within the window: the briefing must be HELD, never dropped, and the
    // client must not have received it yet (the swallowed-answer live bug).
    await new Promise(r => setTimeout(r, 250));
    const midTrace = (await traceKinds(backendId)).slice(traceBefore);
    expect(
      midTrace.some(e => e.kind === 'tts.hold' && (e.payload as any)?.eventType === 'narration:briefing'),
      'direct-response briefing should trace tts.hold',
    ).toBe(true);
    expect(
      midTrace.some(e => e.kind === 'tts.drop' && (e.payload as any)?.eventType === 'narration:briefing'),
      'the answer briefing must not be dropped',
    ).toBe(false);
    const midBriefings = (await h.client.events(devSessionId, startIdx)).events
      .filter((e: AnyEvent) => e.type === 'narration:briefing');
    expect(midBriefings, 'briefing must not reach the client while floor closed').toHaveLength(0);

    // After the window the held briefing is released and ACTUALLY arrives.
    const t0 = Date.now();
    let delivered: AnyEvent | undefined;
    while (Date.now() - t0 < 5000) {
      delivered = ((await h.client.events(devSessionId, startIdx)).events as AnyEvent[])
        .find(e => e.type === 'narration:briefing' && (e.payload as any)?.briefingId === 'module/core');
      if (delivered) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(delivered, 'the answer the user asked for must be heard, not swallowed').toBeTruthy();
    const released = (await traceKinds(backendId)).slice(traceBefore).some(e => e.kind === 'tts.release');
    expect(released).toBe(true);
  }, 60_000);

  it('a second utterance before release supersedes the held briefing', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    seedBriefings();
    const backendId = await backendIdOf(devSessionId);
    const traceBefore = (await traceKinds(backendId)).length;
    const startIdx = (await h.client.events(devSessionId)).events.length;

    await h.client.voiceSimulate(devSessionId, 'speaking_started');
    await h.client.voiceSimulate(devSessionId, 'speaking_stopped');
    await h.client.utter(devSessionId, 'tell me about core'); // held
    await new Promise(r => setTimeout(r, 150));
    await h.client.voiceSimulate(devSessionId, 'speaking_started'); // user talks again
    const kinds = (await traceKinds(backendId)).slice(traceBefore);
    expect(kinds.some(e => e.kind === 'tts.discard_pending')).toBe(true);

    await h.client.voiceSimulate(devSessionId, 'speaking_stopped');
    await h.client.utter(devSessionId, 'tell me about utils');

    // Only the second briefing (utils) ever reaches the client; the
    // superseded core briefing was discarded, not delivered late.
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const has = ((await h.client.events(devSessionId, startIdx)).events as AnyEvent[])
        .some(e => e.type === 'narration:briefing' && (e.payload as any)?.briefingId === 'module/utils');
      if (has) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const briefingIds = ((await h.client.events(devSessionId, startIdx)).events as AnyEvent[])
      .filter(e => e.type === 'narration:briefing')
      .map(e => (e.payload as any)?.briefingId);
    expect(briefingIds).toContain('module/utils');
    expect(briefingIds, 'superseded briefing must not be delivered late').not.toContain('module/core');
  }, 60_000);
});

/**
 * Answered turns climb the knowledge ladder. Live bug 2026-06-09: a whole
 * session of Q&A about a module left comprehension frozen — Seen 0%, count
 * stuck at 1 — because streamed answers fed the model NOTHING.
 *
 * New contract (creditAnswerComprehension via dispatchAnswerVisual):
 *  - nodes the answer's REFS resolve to observe 'heard' (reason qa_answer);
 *  - a node the user NAMED in their question observes 'explained';
 *  - comprehension:updated events fire so the knowledge strip moves live.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-qa-comp';
let h: TetherlineHarness;

const REFS_ANSWER = 'The core module owns the capture flow. The idempotency store backs it.\nREFS: core';

function msg(req: { messages: unknown }): string { return JSON.stringify(req.messages); }

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'core', description: 'd', commitHashes: [], significance: 'minor', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'Fixture.', purpose: 'Comprehension test.', techStack: [], keyAreas: [], conceptualSteps: [] });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'capture pipeline' }] });
  m.onTool('summarize_files', { summaries: [] });
  m.onTool('classify_intent', { skillName: 'none', confidence: 0.8, params: {} });
  m.onText(req => !req.tool && msg(req).includes('core'), REFS_ANSWER);
  m.onText(req => !req.tool, 'A general answer with no refs.\nREFS: none');
  return m;
}

type AnyEvent = { type: string; payload?: any };

async function waitFor(devSessionId: string, since: number, pred: (e: AnyEvent) => boolean, timeoutMs = 10_000): Promise<AnyEvent> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const evs = (await h.client.events(devSessionId, since)).events as AnyEvent[];
    const found = evs.find(pred);
    if (found) return found;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for event');
}

async function startSettled(): Promise<string> {
  const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
  await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PREVIOUSLY_ON', 'HEATMAP', 'WRAP_UP'], 45_000);
  if ((await h.client.getSession(devSessionId)).state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    await new Promise(r => setTimeout(r, 100));
  }
  return devSessionId;
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('answered turns feed comprehension', () => {
  it('a question NAMING a module advances it to explained, live via comprehension:updated', async () => {
    const id = await startSettled();
    const before = await h.client.comprehension(FIXTURE) as { items?: Array<{ itemId: string; level: string }> };
    const beforeCore = (before.items ?? []).find(i => i.itemId === 'module/core');
    const startIdx = (await h.client.events(id)).events.length;

    void h.client.utter(id, 'give me the rundown about the core flow please');

    const update = await waitFor(
      id, startIdx,
      e => e.type === 'comprehension:updated' && e.payload.itemId === 'module/core',
    );
    expect(['heard', 'engaged', 'explained']).toContain(update.payload.level);
    // The user named "core" in the question — that's active engagement.
    expect(update.payload.level).toBe('explained');

    const after = await h.client.comprehension(FIXTURE) as { items?: Array<{ itemId: string; level: string }> };
    const afterCore = (after.items ?? []).find(i => i.itemId === 'module/core');
    expect(afterCore).toBeTruthy();
    expect(afterCore!.level).toBe('explained');
    // It moved relative to where it started (frozen-ladder regression guard).
    expect(afterCore!.level).not.toBe(beforeCore?.level ?? 'unknown');
  }, 60_000);

  it('answers about nothing resolvable do not invent comprehension entries', async () => {
    const id = await startSettled();
    const startIdx = (await h.client.events(id)).events.length;

    void h.client.utter(id, 'ramble about engineering philosophy generally speaking');
    await waitFor(id, startIdx, e => e.type === 'narration:stream_chunk' && e.payload.isFinal);

    const evs = (await h.client.events(id, startIdx)).events as AnyEvent[];
    const updates = evs.filter(e => e.type === 'comprehension:updated' && e.payload.reason === 'qa_answer');
    expect(updates).toHaveLength(0);
  }, 60_000);
});

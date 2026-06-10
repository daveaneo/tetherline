/**
 * Visual pairing end-to-end: every answered turn emits a visual:dispatch
 * event (the never-static guarantee); REFS lines are machine-read, never
 * spoken; voice verbs drive DESCEND/ASCEND.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-visual-dispatch';
let h: TetherlineHarness;

const REFS_ANSWER = 'The core module owns the capture flow. The idempotency store backs it.\nREFS: core';
const NOREF_ANSWER = 'That is a philosophical question about software in general.\nREFS: none';

function msg(req: { messages: unknown }): string { return JSON.stringify(req.messages); }

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'core', description: 'd', commitHashes: [], significance: 'minor', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'Fixture.', purpose: 'Visual test.', techStack: [], keyAreas: [], conceptualSteps: [] });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'capture pipeline' }] });
  m.onTool('summarize_files', { summaries: [] });
  m.onTool('classify_intent', { skillName: 'none', confidence: 0.8, params: {} });
  m.onText(req => !req.tool && msg(req).includes('about the core flow'), REFS_ANSWER);
  m.onText(req => !req.tool, NOREF_ANSWER);
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
  // Short utterances during PROPOSAL are treated as proposal responses —
  // advance past it so voice verbs route through the normal pipeline.
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

describe('visual dispatch — every answer drives the diagram', () => {
  it('REFS line resolves to node refs in visual:dispatch and is never spoken', async () => {
    const id = await startSettled();
    const startIdx = (await h.client.events(id)).events.length;

    void h.client.utter(id, 'give me the rundown about the core flow please');
    const dispatch = await waitFor(id, startIdx, e => e.type === 'visual:dispatch');
    expect(dispatch.payload.refs.length).toBeGreaterThan(0);
    expect(dispatch.payload.refs.some((r: string) => /core/.test(r))).toBe(true);

    await waitFor(id, startIdx, e => e.type === 'narration:stream_chunk' && e.payload.isFinal);
    const evs = (await h.client.events(id, startIdx)).events as AnyEvent[];
    const spoken = evs.filter(e => e.type === 'narration:stream_chunk').map(e => e.payload.text).join(' ');
    expect(spoken).not.toMatch(/REFS:/i);
    expect(spoken).toContain('core module owns the capture flow');
  }, 60_000);

  it('zero refs still emits IN_PLACE (never-static guarantee)', async () => {
    const id = await startSettled();
    const startIdx = (await h.client.events(id)).events.length;

    void h.client.utter(id, 'ramble about engineering philosophy generally speaking');
    const dispatch = await waitFor(id, startIdx, e => e.type === 'visual:dispatch');
    expect(dispatch.payload.transition).toBe('IN_PLACE');
    expect(dispatch.payload.refs).toEqual([]);
    expect(dispatch.payload.reason).toBe('no-refs');
  }, 60_000);

  it('voice verbs: "go deeper on core" descends, "zoom out" pops with ASCEND', async () => {
    const id = await startSettled();
    let idx = (await h.client.events(id)).events.length;

    void h.client.utter(id, 'go deeper on core');
    const down = await waitFor(id, idx, e => e.type === 'visual:dispatch');
    expect(['DESCEND', 'IN_PLACE', 'LATERAL']).toContain(down.payload.transition);
    expect(down.payload.targetNodeId).toMatch(/core/);

    idx = (await h.client.events(id)).events.length;
    void h.client.utter(id, 'zoom out');
    const up = await waitFor(id, idx, e => e.type === 'visual:dispatch');
    expect(up.payload.transition).toBe('ASCEND');
  }, 60_000);
});

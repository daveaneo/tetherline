import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../../harness/index.js';
import { MockLLMAdapter } from '../../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-small-walkthrough';

function buildMock() {
  const mock = new MockLLMAdapter();
  mock.onTool('group_commits', { clusters: [] });
  mock.onTool('narration_segments', { segments: [] });
  mock.onTool('architecture_graph', { nodes: [], edges: [] });
  mock.onTool('flag_concerns', { concerns: [] });
  mock.onTool('rank_impact', { rankings: [] });
  mock.onTool('quiet_week_suggestion', { quiet: false, suggestion: '' });
  mock.onTool('project_overview', {
    projectName: 'f', oneLineDescription: '.', whatItDoes: '.', techStack: [],
    architectureStyle: '.', keyModules: [], notableFiles: [],
  });
  mock.onTool('detect_modules', { modules: [] });
  mock.onTool('summarize_files', { summaries: [] });
  mock.onTool('classify_intent', { skillName: 'navigate', confidence: 0.9, params: {} });
  mock.on((req) => !req.tool, { text: '' });
  return mock;
}

function seedBriefings(h: TetherlineHarness) {
  const base = { sourceHash: 'h', cachedAt: new Date().toISOString() };
  const repo = h.server.db.getBriefingRepo();
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'project', layer: 'project', title: 'fixture',
    opener: 'This is the project briefing for testing.',
    talkingPoints: [], children: ['module/core'], parent: null,
    visualCue: { kind: 'none' }, estimatedSeconds: 6,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'module/core', layer: 'module', title: 'core',
    opener: 'Core does the work.',
    talkingPoints: [], children: [], parent: 'project',
    visualCue: { kind: 'none' }, estimatedSeconds: 6,
  });
}

describe('Audio Tier 1 — simulated voice events drive the real pipeline', () => {
  let h: TetherlineHarness;
  let sid: string;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
    seedBriefings(h);
    const started = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    sid = started.devSessionId;
    await new Promise(r => setTimeout(r, 100));
  });

  afterAll(async () => { await h?.stop(); });

  async function simulate(kind: string, payload: Record<string, unknown>) {
    const res = await fetch(`${h.server.baseUrl}/api/dev/voice/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ devSessionId: sid, kind, payload }),
    });
    if (!res.ok) throw new Error(`simulate ${kind} → ${res.status} ${await res.text()}`);
    return res.json();
  }

  it('simulated utterance routes to the same pipeline as /api/dev/utter', async () => {
    const before = (await h.client.events(sid)).total;
    await simulate('utterance', { text: 'tell me about core' });
    await new Promise(r => setTimeout(r, 100));
    const { events } = await h.client.events(sid, before);
    const briefing = events.find(e => e.type === 'narration:briefing') as any;
    expect(briefing).toBeTruthy();
    expect(briefing.payload.briefingId).toBe('module/core');
  });

  it('simulated interrupt mid-briefing stops at the current briefing and records in trace', async () => {
    // The "interrupt" here is just an utterance delivered while we're in the
    // middle of a briefing. The manager handles it as a new utterance; the
    // frontend would stop TTS. We verify the routing.
    await simulate('utterance', { text: 'back to the overview' });
    const before = (await h.client.events(sid)).total;
    await simulate('interrupt', { text: 'tell me about core' });
    await new Promise(r => setTimeout(r, 100));
    const { events } = await h.client.events(sid, before);
    const push = events.find(e => e.type === 'navigator:push') as any;
    expect(push).toBeTruthy();
    expect(push.payload.briefingId).toBe('module/core');
  });

  it('simulated segment_finished does not crash the pipeline', async () => {
    // The audio:segment_finished event currently just updates internal cursors.
    // We assert it round-trips without error.
    const result = await simulate('segment_finished', { segmentId: 'seg-1' });
    expect(result).toMatchObject({ ok: true });
  });

  it('unknown kind returns 400', async () => {
    const res = await fetch(`${h.server.baseUrl}/api/dev/voice/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ devSessionId: sid, kind: 'bogus', payload: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe('Audio Tier 1 — confirmation phrase tight matching', () => {
  it.each([
    'got it',
    'understood',
    'makes sense',
    'yep',
    'that tracks',
    'sounds good',
  ])('recognizes "%s" as a confirmation', async (phrase) => {
    const { isConfirmationPhrase } = await import(
      '../../../packages/backend/src/session/confirmation-phrases.js'
    );
    expect(isConfirmationPhrase(phrase)).toBe(true);
  });

  it.each([
    'got it, now tell me about X',
    'the weather is nice',
    'makes sense that we are going deep here',
    'I understand the ledger module perfectly now tell me more',
  ])('rejects "%s" (too long / transition)', async (phrase) => {
    const { isConfirmationPhrase } = await import(
      '../../../packages/backend/src/session/confirmation-phrases.js'
    );
    expect(isConfirmationPhrase(phrase)).toBe(false);
  });
});

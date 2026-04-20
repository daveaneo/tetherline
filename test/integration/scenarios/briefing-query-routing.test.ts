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
    ...base, repoPath: FIXTURE, id: 'project', layer: 'project',
    title: 'fixture-small',
    opener: 'Fixture-small is a tiny test project that exercises Tetherline. It has two modules — core and utils.',
    talkingPoints: [], children: ['arch/root', 'module/core', 'module/utils'], parent: null,
    visualCue: { kind: 'none' }, estimatedSeconds: 10,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'arch/root', layer: 'architecture',
    title: 'Architecture overview',
    opener: 'At the top level there are 2 modules: core and utils. Start at core — it houses the capture and idempotency logic.',
    talkingPoints: ['core', 'utils'], children: ['module/core', 'module/utils'], parent: 'project',
    visualCue: { kind: 'diagram_focus' }, estimatedSeconds: 12,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'module/core', layer: 'module',
    title: 'core',
    opener: 'core. Handles capture and idempotency for money movement. Retries never double-charge.',
    talkingPoints: ['capture.ts', 'idempotency.ts'], children: ['file/src/core/capture.ts'], parent: 'arch/root',
    visualCue: { kind: 'diagram_focus', ref: 'core' }, estimatedSeconds: 10,
  });
}

describe('M7 — briefing query routing', () => {
  let h: TetherlineHarness;
  let sessionId: string;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
    seedBriefings(h);
    const started = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    sessionId = started.devSessionId;
    // Wait for the initial project briefing to land so subsequent event counts are post-opener.
    await h.client.waitForAnyPhase(sessionId, ['ANALYZING', 'ERROR'], 5_000);
  });

  afterAll(async () => { await h?.stop(); });

  it.each([
    'what is this project about',
    'give me an overview',
    'what am i looking at',
  ])('routes project query "%s" to project briefing', async (phrase) => {
    const before = (await h.client.events(sessionId)).total;
    await h.client.utter(sessionId, phrase);
    const { events } = await h.client.events(sessionId, before);
    const briefing = events.find(e => e.type === 'narration:briefing') as any;
    expect(briefing).toBeTruthy();
    expect(briefing.payload.briefingId).toBe('project');
    expect(briefing.payload.cacheHit).toBe(true);
  });

  it.each([
    'walk me through the architecture',
    'show me the architecture',
    'what does the architecture look like',
    'tell me about the structure',
  ])('routes architecture query "%s" to arch/root briefing', async (phrase) => {
    const before = (await h.client.events(sessionId)).total;
    await h.client.utter(sessionId, phrase);
    const { events } = await h.client.events(sessionId, before);
    const briefing = events.find(e => e.type === 'narration:briefing') as any;
    expect(briefing).toBeTruthy();
    expect(briefing.payload.briefingId).toBe('arch/root');
    expect(briefing.payload.layer).toBe('architecture');
  });

  it.each([
    'tell me about core',
    'what is the core module',
    'how does core work',
  ])('routes module query "%s" to module briefing', async (phrase) => {
    const before = (await h.client.events(sessionId)).total;
    await h.client.utter(sessionId, phrase);
    const { events } = await h.client.events(sessionId, before);
    const briefing = events.find(e => e.type === 'narration:briefing') as any;
    expect(briefing).toBeTruthy();
    expect(briefing.payload.briefingId).toBe('module/core');
    expect(briefing.payload.layer).toBe('module');
  });

  it('falls back to the intent classifier for unmatched utterances', async () => {
    const before = (await h.client.events(sessionId)).total;
    await h.client.utter(sessionId, 'unrelated phrase that should not hit a briefing');
    const { events } = await h.client.events(sessionId, before);
    expect(events.find(e => e.type === 'narration:briefing')).toBeUndefined();
  });
});

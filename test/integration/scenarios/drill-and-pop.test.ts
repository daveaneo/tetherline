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
    ...base, repoPath: FIXTURE, id: 'project', layer: 'project', title: 'fixture-small',
    opener: 'Fixture-small is a tiny test project that exercises the analyzer. It has two modules — core and utils.',
    talkingPoints: [], children: ['arch/root', 'module/core', 'module/utils'], parent: null,
    visualCue: { kind: 'none' }, estimatedSeconds: 10,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'arch/root', layer: 'architecture', title: 'Architecture',
    opener: 'Architecture overview. There are 2 top-level modules: core and utils. Start with core.',
    talkingPoints: ['core', 'utils'], children: ['module/core', 'module/utils'], parent: 'project',
    visualCue: { kind: 'diagram_focus' }, estimatedSeconds: 10,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'module/core', layer: 'module', title: 'core',
    opener: 'The core module handles capture and idempotency. Retries never double-charge.',
    talkingPoints: ['capture.ts'], children: ['concept/idempotency'], parent: 'arch/root',
    visualCue: { kind: 'diagram_focus', ref: 'core' }, estimatedSeconds: 10,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'module/utils', layer: 'module', title: 'utils',
    opener: 'The utils module is a grab bag of small helpers used across the project.',
    talkingPoints: [], children: [], parent: 'arch/root',
    visualCue: { kind: 'diagram_focus', ref: 'utils' }, estimatedSeconds: 8,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'concept/idempotency', layer: 'concept', title: 'idempotency',
    opener: 'Idempotency means running the same operation twice gives the same result. Retries are safe.',
    talkingPoints: [], children: [], parent: 'module/core',
    visualCue: { kind: 'none' }, estimatedSeconds: 8,
  });
}

describe('S3-S7 — drill, interrupt, pop, breadcrumb', () => {
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
    // Allow initial project briefing to settle
    await new Promise(r => setTimeout(r, 100));
  });

  afterAll(async () => { await h?.stop(); });

  it('after opener, stack depth is 1 and top is project', async () => {
    const snap = await h.client.navigator(sid);
    expect(snap.depth).toBe(1);
    expect(snap.frames[0].briefingId).toBe('project');
  });

  it('"walk me through the architecture" pushes arch/root', async () => {
    await h.client.utter(sid, 'walk me through the architecture');
    const snap = await h.client.navigator(sid);
    expect(snap.depth).toBe(2);
    expect(snap.frames[snap.frames.length - 1].briefingId).toBe('arch/root');
  });

  it('"tell me about core" pushes module/core', async () => {
    await h.client.utter(sid, 'tell me about core');
    const snap = await h.client.navigator(sid);
    expect(snap.depth).toBe(3);
    expect(snap.frames[snap.frames.length - 1].briefingId).toBe('module/core');
  });

  it('"tell me about idempotency" pushes concept/idempotency', async () => {
    await h.client.utter(sid, 'tell me about idempotency');
    const snap = await h.client.navigator(sid);
    expect(snap.depth).toBe(4);
    expect(snap.frames[snap.frames.length - 1].briefingId).toBe('concept/idempotency');
  });

  it('"go back" pops one level and re-emits the new top with a resume prefix', async () => {
    const before = (await h.client.events(sid)).total;
    await h.client.utter(sid, 'go back');
    const { events } = await h.client.events(sid, before);
    const popEvent = events.find(e => e.type === 'navigator:pop') as any;
    const briefing = events.find(e => e.type === 'narration:briefing') as any;
    expect(popEvent).toBeTruthy();
    expect(popEvent.payload.poppedBriefingId).toBe('concept/idempotency');
    expect(popEvent.payload.currentBriefingId).toBe('module/core');
    expect(briefing).toBeTruthy();
    expect(briefing.payload.briefingId).toBe('module/core');
    expect(briefing.payload.resumePrefix).toMatch(/As I was saying/);

    const snap = await h.client.navigator(sid);
    expect(snap.depth).toBe(3);
  });

  it('"back to the overview" pops all the way to project', async () => {
    await h.client.utter(sid, 'back to the overview');
    const snap = await h.client.navigator(sid);
    expect(snap.depth).toBe(1);
    expect(snap.frames[0].briefingId).toBe('project');
  });

  it('"where are we" emits navigator:breadcrumb with full path', async () => {
    // Rebuild a deeper stack
    await h.client.utter(sid, 'walk me through the architecture');
    await h.client.utter(sid, 'tell me about core');
    const before = (await h.client.events(sid)).total;
    await h.client.utter(sid, 'where are we');
    const { events } = await h.client.events(sid, before);
    const crumb = events.find(e => e.type === 'navigator:breadcrumb') as any;
    expect(crumb).toBeTruthy();
    expect(crumb.payload.depth).toBe(3);
    expect(crumb.payload.breadcrumb).toMatch(/core/);
    expect(crumb.payload.frames).toHaveLength(3);
  });

  it('"go deeper" picks the first child briefing of the current frame', async () => {
    // We're at module/core which has children: [concept/idempotency]
    await h.client.utter(sid, 'go deeper');
    const snap = await h.client.navigator(sid);
    expect(snap.frames[snap.frames.length - 1].briefingId).toBe('concept/idempotency');
  });

  it('"resume" re-emits current briefing with "Picking up…" prefix', async () => {
    const before = (await h.client.events(sid)).total;
    await h.client.utter(sid, 'resume');
    const { events } = await h.client.events(sid, before);
    const briefing = events.find(e => e.type === 'narration:briefing') as any;
    expect(briefing).toBeTruthy();
    expect(briefing.payload.resumePrefix).toMatch(/Picking up/);
  });
});

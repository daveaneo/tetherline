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

describe('S10/S12 — staleness + challenge flow', () => {
  let h: TetherlineHarness;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
  });

  afterAll(async () => { await h?.stop(); });

  it('S12 — challenge/pick returns a recently-explained item', async () => {
    // Seed an explained item
    h.server.db.getComprehensionRepo().upsert({
      repoPath: FIXTURE, itemId: 'module/payments', layer: 'module', label: 'payments',
      level: 'explained', narrationSecondsHeard: 20, questionsAsked: 0,
      lastTouchedAt: new Date().toISOString(), lastSessionId: 's1',
    });
    h.server.db.getBriefingRepo().upsert({
      repoPath: FIXTURE, id: 'module/payments', layer: 'module', title: 'payments',
      opener: 'Payments handles capture.',
      talkingPoints: ['capture', 'idempotency', 'retries'],
      children: [], parent: 'arch/root',
      visualCue: { kind: 'none' }, estimatedSeconds: 10,
      sourceHash: 'h1', cachedAt: new Date().toISOString(),
    });

    const res = await fetch(`${h.server.baseUrl}/api/dev/challenge/pick?repoPath=${encodeURIComponent(FIXTURE)}`);
    const body = await res.json() as any;
    expect(body.item.itemId).toBe('module/payments');
    expect(body.prompt).toMatch(/payments/);
    expect(body.expectedKeywords).toEqual(['capture', 'idempotency', 'retries']);
  });

  it('S12 — challenge/evaluate passes when response contains expected keywords', async () => {
    const res = await fetch(`${h.server.baseUrl}/api/dev/challenge/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: FIXTURE,
        itemId: 'module/payments',
        response: 'It handles capture with idempotency so retries are safe.',
      }),
    });
    const body = await res.json() as any;
    expect(body.passed).toBe(true);
    expect(body.matchedKeywords).toEqual(expect.arrayContaining(['capture', 'idempotency']));

    // Item should now be confirmed
    const map = await h.client.comprehension(FIXTURE);
    const item = map.items.find(i => i.itemId === 'module/payments');
    expect(item!.level).toBe('confirmed');
  });

  it('S12 — challenge/evaluate fails when response is too short or off-topic', async () => {
    // Reset to explained
    h.server.db.getComprehensionRepo().upsert({
      repoPath: FIXTURE, itemId: 'module/payments', layer: 'module', label: 'payments',
      level: 'explained', narrationSecondsHeard: 20, questionsAsked: 0,
      lastTouchedAt: new Date().toISOString(), lastSessionId: 's1',
    });
    const res = await fetch(`${h.server.baseUrl}/api/dev/challenge/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: FIXTURE,
        itemId: 'module/payments',
        response: 'um',
      }),
    });
    const body = await res.json() as any;
    expect(body.passed).toBe(false);
    // Level should still be explained
    const map = await h.client.comprehension(FIXTURE);
    expect(map.items.find(i => i.itemId === 'module/payments')!.level).toBe('explained');
  });

  it('S10 — staleness: warmer fully resets a proven item when briefing sourceHash drifts (v3)', async () => {
    // Seed a briefing + a fully-proven comprehension item with matching sourceHash
    h.server.db.getBriefingRepo().upsert({
      repoPath: FIXTURE, id: 'module/old', layer: 'module', title: 'old',
      opener: 'The old module.',
      talkingPoints: [], children: [], parent: null,
      visualCue: { kind: 'none' }, estimatedSeconds: 5,
      sourceHash: 'original', cachedAt: new Date().toISOString(),
    });
    h.server.db.getComprehensionRepo().upsert({
      repoPath: FIXTURE, itemId: 'module/old', layer: 'module', label: 'old',
      level: 'explained', narrationSecondsHeard: 10, questionsAsked: 1,
      seen: true, grilled: true, quizCorrect: 3, quizTotal: 3,
      lastTouchedAt: new Date().toISOString(), lastSessionId: 'prev',
    });

    // Directly call the warmer with a mock cache that produces a DIFFERENT
    // sourceHash for the same briefing id. Simulates underlying code drift.
    const { warmBriefings } = await import('../../../packages/backend/src/briefing/warmer.js');
    // Stub a cache repo that returns one module with the same path but
    // different summary → different source hash.
    const stub: any = {
      getProject: () => ({ repoPath: FIXTURE, summary: 'A project that changed.', purpose: 'something else', techStack: [], moduleMap: {}, triggerHashes: { head: 'new' }, confidence: 0.9 }),
      getModulesForRepo: () => [{ repoPath: FIXTURE, modulePath: 'old', summary: 'The old module has been REWRITTEN.', source: 'llm', keyFiles: ['old/new-file.ts'], dependencies: [], confidence: 0.9, generatedAt: new Date().toISOString() }],
      getModule: (_: string, p: string) => p === 'old' ? { repoPath: FIXTURE, modulePath: 'old', summary: 'The old module has been REWRITTEN.', source: 'llm', keyFiles: ['old/new-file.ts'], dependencies: [], confidence: 0.9, generatedAt: new Date().toISOString() } : null,
      getFilesForRepo: () => [],
      getFile: () => null,
      getQA: () => [],
    };

    const result = await warmBriefings(
      FIXTURE,
      stub,
      h.server.db.getBriefingRepo(),
      null,
      h.server.db.getComprehensionRepo(),
    );
    expect(result.staled).toEqual(expect.arrayContaining(['module/old']));

    // v3: content changed → the PROOF is stale. Level degrades to
    // 'heard' (knew the old version); grilled/quiz/seen all cleared so
    // it re-counts as a gap until re-proven on the new content.
    const item = h.server.db.getComprehensionRepo().get(FIXTURE, 'module/old');
    expect(item!.level).toBe('heard');
    expect(item!.seen).toBe(false);
    expect(item!.grilled).toBe(false);
    expect(item!.quizTotal).toBe(0);
  });
});

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../../harness/index.js';
import { MockLLMAdapter } from '../../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-small-walkthrough';

let h: TetherlineHarness;

function buildMock() {
  const mock = new MockLLMAdapter();
  mock.onTool('group_commits', { clusters: [] });
  mock.onTool('narration_segments', { segments: [] });
  mock.onTool('architecture_graph', { nodes: [], edges: [] });
  mock.onTool('flag_concerns', { concerns: [] });
  mock.onTool('rank_impact', { rankings: [] });
  mock.onTool('quiet_week_suggestion', { quiet: false, suggestion: '' });
  mock.onTool('project_overview', {
    projectName: 'fixture-small', oneLineDescription: '.', whatItDoes: '.', techStack: [],
    architectureStyle: '.', keyModules: [], notableFiles: [],
  });
  mock.onTool('detect_modules', { modules: [] });
  mock.onTool('summarize_files', { summaries: [] });
  mock.onTool('classify_intent', { skillName: 'navigate', confidence: 0.9, params: {} });
  mock.on((req) => !req.tool, { text: '' });
  return mock;
}

describe('S1 — opening pitch delivered in under 2s when a cached briefing exists', () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
  });

  afterAll(async () => { await h?.stop(); });

  it('emits narration:briefing with layer=project within 2000ms of session start', async () => {
    h = await tetherline.start({ mock: buildMock() });

    // Seed the briefings table directly so we're testing delivery, not generation.
    h.server.db.getBriefingRepo().upsert({
      id: 'project',
      repoPath: FIXTURE,
      layer: 'project',
      title: 'fixture-small',
      opener: 'Fixture-small is a tiny test project that exercises the Tetherline analyzer. It has two modules — core and utils — and a deterministic commit history. Use it to validate end-to-end flows.',
      detail: undefined,
      talkingPoints: ['capture', 'idempotency', 'retries'],
      children: ['arch/root', 'module/core', 'module/utils'],
      parent: null,
      visualCue: { kind: 'none' },
      estimatedSeconds: 12,
      sourceHash: 'testhash',
      cachedAt: new Date().toISOString(),
    });

    const t0 = Date.now();
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE,
      entryMode: 'updates',
      sinceDays: 30,
    });

    // Poll events for the narration:briefing event.
    let briefingEvent: any = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !briefingEvent) {
      const { events } = await h.client.events(devSessionId);
      briefingEvent = events.find(e => e.type === 'narration:briefing');
      if (!briefingEvent) await new Promise(r => setTimeout(r, 50));
    }

    const elapsedMs = Date.now() - t0;
    expect(briefingEvent).toBeTruthy();
    expect(elapsedMs).toBeLessThan(2000);
    expect(briefingEvent.payload.briefingId).toBe('project');
    expect(briefingEvent.payload.layer).toBe('project');
    expect(briefingEvent.payload.cacheHit).toBe(true);
    expect(briefingEvent.payload.text).toMatch(/Fixture-small/);
    expect(briefingEvent.payload.estimatedSeconds).toBeLessThanOrEqual(45);
  }, 30_000);
});

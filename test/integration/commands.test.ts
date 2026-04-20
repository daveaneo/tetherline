import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-small-walkthrough';

function buildMock() {
  const mock = new MockLLMAdapter();
  mock.onTool('group_commits', { clusters: [
    { id: 'a1', name: 'Area One', description: 'Seed.', significance: 'minor', theme: 't', commitHashes: [], affectedFiles: [] },
  ]});
  mock.onTool('narration_segments', { segments: [
    { id: 's1', text: 'segment one', visualCue: { type: 'none' } },
  ]});
  mock.onTool('architecture_graph', { nodes: [], edges: [] });
  mock.onTool('flag_concerns', { concerns: [] });
  mock.onTool('rank_impact', { rankings: [] });
  mock.onTool('quiet_week_suggestion', { quiet: false, suggestion: '' });
  mock.onTool('project_overview', {
    projectName: 'f', oneLineDescription: '.', whatItDoes: '.', techStack: [],
    architectureStyle: '.', keyModules: [], notableFiles: [],
  });
  mock.onTool('classify_intent', { skillName: 'navigate', confidence: 0.9, params: { direction: 'next' } });
  mock.onTool('detect_modules', { modules: [] });
  mock.onTool('summarize_files', { summaries: [] });
  mock.on((req) => !req.tool, { text: 'ok' });
  return mock;
}

describe('commands', () => {
  let h: TetherlineHarness;
  let sessionId: string;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
    const started = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    sessionId = started.devSessionId;
    await h.client.waitForAnyPhase(sessionId,
      ['PROPOSAL','OVERVIEW','AREA_WALKTHROUGH','COMPONENT_TOUR','PROJECT_OVERVIEW','PREVIOUSLY_ON','ERROR'],
      30_000);
  });

  afterAll(async () => { await h?.stop(); });

  it('accepts command:next', async () => {
    const res = await h.client.command(sessionId, 'next');
    expect(res.ok).toBe(true);
  });

  it('accepts command:pause then command:resume', async () => {
    const pause = await h.client.command(sessionId, 'pause');
    expect(pause.ok).toBe(true);
    const resume = await h.client.command(sessionId, 'resume');
    expect(resume.ok).toBe(true);
  });

  it('accepts command:skip', async () => {
    const res = await h.client.command(sessionId, 'skip');
    expect(res.ok).toBe(true);
  });
});

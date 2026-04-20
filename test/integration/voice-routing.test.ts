import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-small-walkthrough';

function buildMock(intentOverride?: { skillName: string; confidence: number; params: Record<string, string> }) {
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
  mock.onTool('classify_intent', intentOverride ?? {
    skillName: 'navigate', confidence: 0.9, params: { direction: 'next' },
  });
  mock.on((req) => !req.tool, { text: 'This project covers idempotent capture.' });
  return mock;
}

describe('voice utterance routing', () => {
  let h: TetherlineHarness;
  let sessionId: string;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
    const started = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    sessionId = started.devSessionId;
  });

  afterAll(async () => { await h?.stop(); });

  it('accepts a "next"-class utterance via navigation phrases (no LLM needed)', async () => {
    const res = await h.client.utter(sessionId, 'next');
    expect(res.ok).toBe(true);
  });

  it('accepts a "skip" utterance', async () => {
    const res = await h.client.utter(sessionId, 'skip');
    expect(res.ok).toBe(true);
  });

  it('accepts a free-form question utterance', async () => {
    const res = await h.client.utter(sessionId, 'what is this project about');
    expect(res.ok).toBe(true);
    // narration:greeting or qa:answer_chunk should eventually show up; we assert
    // only that the endpoint returned and the pipeline didn't crash.
  });

  it('records utterance.received trace events', async () => {
    const { events } = await h.client.trace({ limit: 100 });
    const utterances = events.filter(e => (e as any).kind === 'utterance.received');
    expect(utterances.length).toBeGreaterThan(0);
  });
});

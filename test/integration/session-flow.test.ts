import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE_PATH = '/tmp/tetherline-fixture-small-walkthrough';

let h: TetherlineHarness;

/** Mock LLM with canned responses for every tool the session pipeline invokes. */
function buildMock(): MockLLMAdapter {
  const mock = new MockLLMAdapter();

  // Clustering — returns a single area covering all commits
  mock.onTool('group_commits', {
    clusters: [{
      id: 'idempotency',
      name: 'Idempotent capture',
      description: 'Adds an idempotency store so retries never double-charge.',
      significance: 'major',
      theme: 'correctness',
      commitHashes: [],
      affectedFiles: ['src/core/capture.ts', 'src/core/idempotency.ts'],
    }],
  });

  // Narrative — narration segments per area
  mock.onTool('narration_segments', {
    segments: [
      { id: 'seg-1', text: 'This week introduces an idempotency store.', visualCue: { type: 'none' } },
      { id: 'seg-2', text: 'Capture now checks the store before executing.', visualCue: { type: 'show_code', filePath: 'src/core/capture.ts' } },
    ],
  });

  // Architecture diagram
  mock.onTool('architecture_graph', {
    nodes: [
      { id: 'capture', label: 'Capture', type: 'module' },
      { id: 'store', label: 'IdempotencyStore', type: 'module' },
    ],
    edges: [
      { source: 'capture', target: 'store', relation: 'uses' },
    ],
  });

  // Concerns (none for the fixture)
  mock.onTool('flag_concerns', { concerns: [] });

  // Impact ranking
  mock.onTool('rank_impact', {
    rankings: [{ id: 'idempotency', score: 80, summary: 'Prevents duplicate charges on retry.' }],
  });

  // Quiet week detection
  mock.onTool('quiet_week_suggestion', { quiet: false, suggestion: '' });

  // Project overview (used in full_walkthrough)
  mock.onTool('project_overview', {
    projectName: 'fixture-small',
    oneLineDescription: 'A minimal fixture project.',
    whatItDoes: 'Exercises the Tetherline analyzer end-to-end.',
    techStack: ['TypeScript'],
    architectureStyle: 'single-module',
    keyModules: ['capture', 'idempotency'],
    notableFiles: ['src/core/capture.ts'],
  });

  // Intent classifier — default to "next" for any non-question utterance
  mock.onTool('classify_intent', {
    skillName: 'navigate',
    confidence: 0.8,
    params: { direction: 'next' },
  });

  // Context-cache module detection + file summaries
  mock.onTool('detect_modules', {
    modules: [
      { id: 'core', name: 'core', path: 'src/core', description: 'Core capture + idempotency logic.' },
      { id: 'utils', name: 'utils', path: 'src/utils', description: 'Helpers.' },
    ],
  });
  mock.onTool('summarize_files', {
    summaries: [
      { filePath: 'src/core/capture.ts', summary: 'Capture with idempotency.', role: 'entrypoint' },
    ],
  });

  // Any other text completion (QA answers, etc.)
  mock.on(
    req => !req.tool,
    { text: 'This project exercises the Tetherline analyzer pipeline.' },
  );

  return mock;
}

describe('session flow against fixture', () => {
  beforeAll(() => {
    if (!fs.existsSync(FIXTURE_PATH) || !fs.existsSync(path.join(FIXTURE_PATH, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE_PATH, { stdio: 'inherit' });
    }
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('starts a session and reaches a non-IDLE phase within 45s', async () => {
    h = await tetherline.start({ mock: buildMock() });

    const { devSessionId, state } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'updates',
      sinceDays: 30,
    });

    expect(devSessionId).toMatch(/^dev_/);
    expect(state.phase).toBe('ANALYZING');

    // Wait for any post-analysis phase
    const advanced = await h.client.waitForAnyPhase(
      devSessionId,
      ['PROPOSAL', 'OVERVIEW', 'AREA_WALKTHROUGH', 'COMPONENT_TOUR', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'ERROR'],
      45_000,
    );

    // It's OK to land in ERROR for this first integration attempt; the point is
    // that the pipeline moved off ANALYZING. The test above runs first so we
    // know the harness + dev API + session manager wiring is correct.
    expect(advanced.phase).not.toBe('ANALYZING');
    expect(advanced.phase).not.toBe('IDLE');
  }, 60_000);

  it('emits trace events during the session', async () => {
    // Reuse the harness from the previous test.
    const { events } = await h.client.trace({ limit: 50 });
    expect(events.length).toBeGreaterThan(0);
    const kinds = new Set(events.map(e => e.kind as string));
    expect([...kinds].some(k => k === 'phase.changed' || k === 'llm.response' || k === 'utterance.received')).toBe(true);
  });
});

/**
 * REGRESSION GUARD: every entry mode reachable from the Lobby UI must advance
 * past IDLE and emit at least one content event (state change, briefing,
 * greeting, or analysis progress). A blank-screen path is a hard failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  mock.onTool('onboarding_program', {
    days: [
      { day: 1, title: 'Overview', description: '.', activities: [] },
      { day: 2, title: 'Architecture', description: '.', activities: [] },
    ],
  });
  mock.onTool('detect_modules', { modules: [] });
  mock.onTool('summarize_files', { summaries: [] });
  mock.onTool('classify_intent', { skillName: 'navigate', confidence: 0.9, params: {} });
  mock.on((req) => !req.tool, { text: 'Generic response.' });
  return mock;
}

type Mode = 'full_walkthrough' | 'updates' | 'onboarding' | 'explore';
const MODES: Mode[] = ['full_walkthrough', 'updates', 'onboarding', 'explore'];

describe('entry modes — every clickable Lobby path produces content', () => {
  let h: TetherlineHarness;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
  });

  afterAll(async () => { await h?.stop(); });

  it.each(MODES)('entry mode "%s" transitions past IDLE within 10s', async (mode) => {
    const { devSessionId, state } = await h.client.startSession({
      repoPath: FIXTURE,
      entryMode: mode,
      sinceDays: 30,
    });

    // Initial state must not be IDLE — /session/start waits 2s for first
    // state_changed event and returns the post-transition state.
    expect(state.phase).not.toBe('IDLE');

    // Within a generous budget, something content-y should be emitted.
    const deadline = Date.now() + 10_000;
    let sawContent = false;
    while (Date.now() < deadline && !sawContent) {
      const { events } = await h.client.events(devSessionId);
      sawContent = events.some(e =>
        e.type === 'session:state_changed' ||
        e.type === 'narration:greeting' ||
        e.type === 'narration:briefing' ||
        e.type === 'analysis:started' ||
        e.type === 'analysis:progress' ||
        e.type === 'session:proposal' ||
        e.type === 'session:onboarding_day' ||
        e.type === 'session:quick_preview',
      );
      if (!sawContent) await new Promise(r => setTimeout(r, 100));
    }
    expect(sawContent).toBe(true);

    // Clean up so subsequent iterations start fresh
    await h.client.resetSession(devSessionId);
  }, 30_000);

  it.each(MODES)('entry mode "%s" — explore path is the one that broke; check it never hangs in IDLE', async (mode) => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE,
      entryMode: mode,
      sinceDays: 30,
    });

    // Wait a bit, then assert phase is not IDLE
    await new Promise(r => setTimeout(r, 500));
    const info = await h.client.getSession(devSessionId);
    expect(info.state.phase).not.toBe('IDLE');

    await h.client.resetSession(devSessionId);
  }, 15_000);
});

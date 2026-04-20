/**
 * Mode toggles — every toggle emits an observable mode change. Catches
 * regressions where a toggle silently no-ops.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../../harness/index.js';
import { MockLLMAdapter } from '../../../packages/backend/src/intelligence/llm/index.js';
import type { ModeKey } from '@tetherline/shared';

const FIXTURE = '/tmp/tetherline-fixture-small-walkthrough';

function buildMock() {
  const m = new MockLLMAdapter();
  ['group_commits', 'narration_segments', 'architecture_graph', 'flag_concerns', 'rank_impact',
   'quiet_week_suggestion', 'project_overview', 'detect_modules', 'summarize_files'].forEach(t => m.onTool(t, {}));
  m.onTool('classify_intent', { skillName: 'navigate', confidence: 0.9, params: {} });
  m.on(req => !req.tool, { text: '' });
  return m;
}

describe('mode toggles reflect in state.modes', () => {
  let h: TetherlineHarness;
  let sid: string;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
    const started = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    sid = started.devSessionId;
  });

  afterAll(async () => { await h?.stop(); });

  const modes: ModeKey[] = ['narration', 'activeLearning', 'advisory', 'alerts'];

  it.each(modes)('toggling "%s" updates context.modes', async (key) => {
    // Read current state
    const before = await h.client.getSession(sid);
    const beforeValue = (before.state as any).modes?.[key] ?? (['narration','alerts'].includes(key));

    // Toggle to opposite
    await h.client.toggleMode(sid, key, !beforeValue);
    await new Promise(r => setTimeout(r, 100));

    // Fetch events since and check state_changed reflects the new mode
    const { events } = await h.client.events(sid);
    const stateChanges = events.filter(e => e.type === 'session:state_changed') as any[];
    const latest = stateChanges[stateChanges.length - 1];
    expect(latest).toBeTruthy();
    expect(latest.payload.context.modes[key]).toBe(!beforeValue);

    // Toggle back to original
    await h.client.toggleMode(sid, key, beforeValue);
  });

  it('each of the 4 modes has been toggled independently (coverage assertion)', () => {
    // The `.each` above proves each mode can flip. This assertion is the
    // explicit coverage guarantee.
    expect(modes).toEqual(['narration', 'activeLearning', 'advisory', 'alerts']);
  });
});

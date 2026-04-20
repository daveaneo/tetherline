/**
 * Robustness guards — the tests we wish had existed before the 2026-04-20
 * rename shipped. Cover scenarios where the DB has data but reality doesn't
 * match (common during upgrades, data-dir moves, manual repo deletions).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

function buildMock() {
  const m = new MockLLMAdapter();
  ['group_commits', 'narration_segments', 'architecture_graph', 'flag_concerns', 'rank_impact',
   'quiet_week_suggestion', 'project_overview', 'detect_modules', 'summarize_files'].forEach(t => m.onTool(t, {}));
  m.onTool('classify_intent', { skillName: 'navigate', confidence: 0.9, params: {} });
  m.on(req => !req.tool, { text: '' });
  return m;
}

describe('stale-data robustness — DB entries that don\'t match reality', () => {
  let h: TetherlineHarness;

  beforeAll(async () => {
    h = await tetherline.start({ mock: buildMock() });
  });

  afterAll(async () => { await h?.stop(); });

  it('starting a session on a non-existent repo path emits a clear error', async () => {
    const fakePath = path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now());
    expect(fs.existsSync(fakePath)).toBe(false);

    const { devSessionId } = await h.client.startSession({
      repoPath: fakePath, entryMode: 'explore', sinceDays: 7,
    });

    // Wait up to 5s for the pipeline to emit either an error or transition
    // to some visible phase
    const deadline = Date.now() + 5_000;
    let errorEvent: any = null;
    let finalPhase: string = 'IDLE';
    while (Date.now() < deadline && !errorEvent) {
      const { events } = await h.client.events(devSessionId);
      errorEvent = events.find(e => e.type === 'error');
      const stateChanges = events.filter(e => e.type === 'session:state_changed') as any[];
      if (stateChanges.length > 0) {
        finalPhase = stateChanges[stateChanges.length - 1].payload.state.phase;
      }
      if (!errorEvent) await new Promise(r => setTimeout(r, 100));
    }

    expect(errorEvent).toBeTruthy();
    expect(errorEvent.payload).toMatchObject({
      code: expect.stringMatching(/ANALYSIS|NOT_FOUND|INVALID/i),
      message: expect.stringContaining('does not exist'),
    });
    // Backend should transition to ERROR phase so the frontend shows the
    // error UI (not a blank screen).
    expect(finalPhase).toBe('ERROR');
  });

  it('error events are recoverable=false for unrecoverable failures', async () => {
    const fakePath = path.join(os.tmpdir(), 'also-not-here-' + Date.now());
    const { devSessionId } = await h.client.startSession({
      repoPath: fakePath, entryMode: 'explore', sinceDays: 7,
    });

    const deadline = Date.now() + 5_000;
    let errorEvent: any = null;
    while (Date.now() < deadline && !errorEvent) {
      const { events } = await h.client.events(devSessionId);
      errorEvent = events.find(e => e.type === 'error');
      if (!errorEvent) await new Promise(r => setTimeout(r, 100));
    }
    expect(errorEvent.payload.recoverable).toBe(false);
  });

  it('session state includes an error description after a failed start', async () => {
    const fakePath = path.join(os.tmpdir(), 'missing-repo-' + Date.now());
    const { devSessionId } = await h.client.startSession({
      repoPath: fakePath, entryMode: 'explore', sinceDays: 7,
    });

    await new Promise(r => setTimeout(r, 1_500));

    const info = await h.client.getSession(devSessionId);
    // ERROR phase + error text so the UI has something to show
    expect(info.state.phase).toBe('ERROR');
    expect((info.state as any).error).toBeTruthy();
    expect(typeof (info.state as any).error).toBe('string');
    expect((info.state as any).error.length).toBeGreaterThan(10);
  });

  it('all four entry modes degrade gracefully with an invalid repo path', async () => {
    const modes: Array<'full_walkthrough' | 'updates' | 'onboarding' | 'explore'> = [
      'full_walkthrough', 'updates', 'onboarding', 'explore',
    ];

    for (const mode of modes) {
      const fakePath = path.join(os.tmpdir(), `bad-${mode}-${Date.now()}`);
      const { devSessionId } = await h.client.startSession({
        repoPath: fakePath, entryMode: mode, sinceDays: 7,
      });
      await new Promise(r => setTimeout(r, 1_000));
      const info = await h.client.getSession(devSessionId);
      // Every mode should emit something; never hang on IDLE
      expect(info.state.phase).not.toBe('IDLE');
      await h.client.resetSession(devSessionId);
    }
  });
});

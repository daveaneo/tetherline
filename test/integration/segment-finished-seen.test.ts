/**
 * Seen-credit targeting: when the client reports a briefing finished playing,
 * the backend must credit the briefing IT NAMED — not whatever was delivered
 * last. Live bug 2026-06-10: handleSegmentFinished ignored its segmentId and
 * always used lastBriefingId, so navigating to a second briefing mid-playback
 * credited the wrong node (and Seen never reflected what was actually heard).
 *
 * Tour segments (ids like "s1", not briefings) must still fall back to
 * lastBriefingId so the walkthrough auto-advance keeps working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-seen';
let h: TetherlineHarness;

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'capture', description: 'd', commitHashes: [], significance: 'minor', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'A fixture.', purpose: 'Seen test.', techStack: [], keyAreas: [], conceptualSteps: [] });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'd' }] });
  m.onTool('summarize_files', { summaries: [] });
  m.onTool('classify_intent', { skillName: 'none', confidence: 0.8, params: {} });
  m.on(req => !req.tool, { text: 'Generic.' });
  return m;
}

function seedBriefings() {
  const base = { sourceHash: 'h', cachedAt: new Date().toISOString() };
  const repo = h.server.db.getBriefingRepo();
  repo.upsert({ ...base, repoPath: FIXTURE, id: 'project', layer: 'project', title: 'fixture', opener: 'A fixture with core and utils.', talkingPoints: [], children: ['module/core', 'module/utils'], parent: null, visualCue: { kind: 'none' }, estimatedSeconds: 10 });
  repo.upsert({ ...base, repoPath: FIXTURE, id: 'module/core', layer: 'module', title: 'core', opener: 'Core records audio.', talkingPoints: [], children: [], parent: 'project', visualCue: { kind: 'diagram_focus', ref: 'core' }, estimatedSeconds: 10 });
  repo.upsert({ ...base, repoPath: FIXTURE, id: 'module/utils', layer: 'module', title: 'utils', opener: 'Utils holds helpers.', talkingPoints: [], children: [], parent: 'project', visualCue: { kind: 'diagram_focus', ref: 'utils' }, estimatedSeconds: 10 });
}

type AnyEvent = { type: string; payload?: any };

async function settle(devSessionId: string) {
  await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PROJECT_OVERVIEW', 'WRAP_UP', 'AREA_WALKTHROUGH'], 45_000);
  if ((await h.client.getSession(devSessionId)).state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function waitForBriefing(devSessionId: string, since: number, briefingId: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const evs = (await h.client.events(devSessionId, since)).events as AnyEvent[];
    if (evs.some(e => e.type === 'narration:briefing' && e.payload?.briefingId === briefingId)) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`briefing ${briefingId} never arrived`);
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('segment_finished credits the briefing the client names', () => {
  it('credits the passed segmentId, not lastBriefingId, after navigating mid-playback', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    seedBriefings();
    const startIdx = (await h.client.events(devSessionId)).events.length;

    // Deliver core, then utils — lastBriefingId is now 'module/utils'.
    await h.client.utter(devSessionId, 'tell me about core');
    await waitForBriefing(devSessionId, startIdx, 'module/core');
    await h.client.utter(devSessionId, 'tell me about utils');
    await waitForBriefing(devSessionId, startIdx, 'module/utils');

    const seenIdx = (await h.client.events(devSessionId)).events.length;
    // The client reports that it finished playing the CORE briefing.
    await h.client.voiceSimulate(devSessionId, 'segment_finished', { segmentId: 'module/core' });

    const t0 = Date.now();
    let seen: AnyEvent | undefined;
    while (Date.now() - t0 < 4000) {
      seen = ((await h.client.events(devSessionId, seenIdx)).events as AnyEvent[])
        .find(e => e.type === 'comprehension:updated' && e.payload?.reason === 'seen');
      if (seen) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(seen, 'a seen update must fire').toBeTruthy();
    expect(seen!.payload.itemId, 'must credit the briefing the client named, not the last delivered').toBe('module/core');

    const utilsSeen = ((await h.client.events(devSessionId, seenIdx)).events as AnyEvent[])
      .some(e => e.type === 'comprehension:updated' && e.payload?.reason === 'seen' && e.payload?.itemId === 'module/utils');
    expect(utilsSeen, 'the un-finished briefing must not be credited').toBe(false);
  }, 60_000);

  it('falls back to lastBriefingId for non-briefing tour segment ids', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    seedBriefings();
    const startIdx = (await h.client.events(devSessionId)).events.length;

    await h.client.utter(devSessionId, 'tell me about core');
    await waitForBriefing(devSessionId, startIdx, 'module/core');

    const seenIdx = (await h.client.events(devSessionId)).events.length;
    // A tour-segment id (not a briefing) → credit lastBriefingId = module/core.
    await h.client.voiceSimulate(devSessionId, 'segment_finished', { segmentId: 's1' });

    const t0 = Date.now();
    let seen: AnyEvent | undefined;
    while (Date.now() - t0 < 4000) {
      seen = ((await h.client.events(devSessionId, seenIdx)).events as AnyEvent[])
        .find(e => e.type === 'comprehension:updated' && e.payload?.reason === 'seen');
      if (seen) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(seen?.payload.itemId, 'unknown segment id falls back to last briefing').toBe('module/core');
  }, 60_000);
});

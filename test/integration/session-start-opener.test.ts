/**
 * Session-start narration (Phase 5):
 *  - updates mode delivers a REAL "N commits since <date>" recap and the
 *    proposal is narrated through the session-open stream (one streamId,
 *    isFinal on its last chunk) — the proposal moment is actually hearable;
 *  - duplicate session:start is ignored (idempotency guard);
 *  - speaking during PROPOSAL never produces the canned "Go ahead.";
 *  - PROPOSAL waits indefinitely (no backend auto-advance).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter, type LLMRequest } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-session-start';
let h: TetherlineHarness;

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'capture', description: 'd', commitHashes: [], significance: 'major', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 80, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'Fixture.', purpose: 'Start test.', techStack: [], keyAreas: [], conceptualSteps: [] });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'd' }] });
  m.onTool('summarize_files', { summaries: [] });
  m.onTool('classify_intent', { skillName: 'none', confidence: 0.8, params: {} });
  m.on(req => !req.tool && req.tool === undefined && JSON.stringify(req.messages).includes('proposal'), { text: 'Proposal text.' });
  m.on((req: LLMRequest) => !req.tool, { text: 'A short grounded answer about the fixture.' });
  return m;
}

type AnyEvent = { type: string; payload?: any };

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('session start — opener, recap, hearable proposal', () => {
  it('updates mode: one open stream carries welcome → "commits since" recap → proposal (isFinal), no greeting events', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await h.client.waitForPhase(devSessionId, 'PROPOSAL', 45_000);
    // Allow the awaited proposal narration to flush.
    await new Promise(r => setTimeout(r, 300));
    const evs = (await h.client.events(devSessionId)).events as AnyEvent[];

    const openChunks = evs
      .filter(e => e.type === 'narration:stream_chunk')
      .map(e => e.payload)
      .filter(p => String(p.streamId).startsWith('open-'));
    expect(openChunks.length).toBeGreaterThanOrEqual(3);

    // One stream, monotonic seq, isFinal exactly once (the proposal's last chunk).
    const streamIds = new Set(openChunks.map(c => c.streamId));
    expect(streamIds.size).toBe(1);
    const finals = openChunks.filter(c => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(openChunks[openChunks.length - 1].isFinal).toBe(true);

    const spoken = openChunks.map(c => c.text).join(' ');
    expect(spoken).toMatch(/Welcome back/);
    expect(spoken).toMatch(/commits? since/);
    // The proposal text is the narrated tail of the stream.
    const proposal = evs.find(e => e.type === 'session:proposal');
    expect(proposal?.payload.narrated).toBe(true);
    expect(spoken).toContain(String(proposal?.payload.message).slice(0, 40));

    // The old path's greeting events are gone from session start.
    const greetings = evs.filter(e => e.type === 'narration:greeting');
    expect(greetings).toHaveLength(0);

    // EXACTLY ONE question in the whole open stream — the proposal's.
    // The live-session triple prompt ("Where do you want to start?" +
    // "Where do you want to pick up?" + the proposal question) was noise.
    const questionMarks = (spoken.match(/\?/g) ?? []).length;
    expect(questionMarks, `open stream must ask exactly one question, got: "${spoken}"`).toBeLessThanOrEqual(1);
  }, 60_000);

  it('explore re-entry: opener chunks are statements; only the proposal asks', async () => {
    // First session stamps the briefing delivery; the immediate second
    // session is the <30min re-entry path that used to stack questions.
    const first = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'explore', sinceDays: 30 });
    await h.client.waitForAnyPhase(first.devSessionId, ['PROPOSAL', 'OVERVIEW'], 45_000);
    await h.client.resetSession(first.devSessionId);

    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'explore', sinceDays: 30 });
    await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW'], 45_000);
    await new Promise(r => setTimeout(r, 300));
    const evs = (await h.client.events(devSessionId)).events as AnyEvent[];

    const openSpoken = evs
      .filter(e => e.type === 'narration:stream_chunk')
      .map(e => e.payload)
      .filter(p => String(p.streamId).startsWith('open-'))
      .map(p => String(p.text)).join(' ');
    const briefingTexts = evs
      .filter(e => e.type === 'narration:briefing')
      .map(e => String(e.payload.text)).join(' ');

    expect(openSpoken).not.toContain('Where do you want to start?');
    expect(briefingTexts).not.toContain('Where do you want to pick up?');
    // At most one question across everything spoken at open (the proposal's).
    const allSpoken = `${openSpoken} ${briefingTexts}`;
    expect((allSpoken.match(/\?/g) ?? []).length, allSpoken).toBeLessThanOrEqual(1);
  }, 90_000);

  it('a duplicate session:start while active is ignored (single analysis, single opener)', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await h.client.waitForPhase(devSessionId, 'PROPOSAL', 45_000);
    const before = (await h.client.events(devSessionId)).events as AnyEvent[];
    const analysisBefore = before.filter(e => e.type === 'analysis:started').length;
    expect(analysisBefore).toBe(1);

    // Replay session:start on the SAME manager (reconnect / double-click).
    await h.client.sendClientEvent(devSessionId, {
      type: 'session:start',
      payload: { repoPath: FIXTURE, sinceDays: 30, entryMode: 'updates' },
    });
    await new Promise(r => setTimeout(r, 800));

    const after = (await h.client.events(devSessionId)).events as AnyEvent[];
    expect(after.filter(e => e.type === 'analysis:started').length).toBe(1);
    const welcomes = after.filter(e =>
      e.type === 'narration:stream_chunk' && /Welcome back|first time/.test(e.payload.text ?? ''));
    expect(welcomes.length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('speaking during PROPOSAL: silent accept, NO "Go ahead.", question gets answered', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await h.client.waitForPhase(devSessionId, 'PROPOSAL', 45_000);
    await new Promise(r => setTimeout(r, 200));
    const idx = (await h.client.events(devSessionId)).events.length;

    await h.client.utter(devSessionId, 'what is the most important thing that changed in here');
    // Wait for the answer's final chunk.
    const t0 = Date.now();
    let final = false;
    while (!final && Date.now() - t0 < 10_000) {
      const evs = (await h.client.events(devSessionId, idx)).events as AnyEvent[];
      final = evs.some(e => e.type === 'narration:stream_chunk' && e.payload.isFinal);
      if (!final) await new Promise(r => setTimeout(r, 50));
    }
    const evs = (await h.client.events(devSessionId, idx)).events as AnyEvent[];
    const allText = evs
      .filter(e => e.type === 'narration:greeting' || e.type === 'narration:stream_chunk')
      .map(e => e.payload.text)
      .join(' ');
    expect(allText).not.toContain('Go ahead');
    expect(allText).toContain('A short grounded answer');
  }, 60_000);

  it('PROPOSAL waits — no backend auto-advance after silence', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await h.client.waitForPhase(devSessionId, 'PROPOSAL', 45_000);
    await new Promise(r => setTimeout(r, 3000));
    expect((await h.client.getSession(devSessionId)).state.phase).toBe('PROPOSAL');
  }, 60_000);
});

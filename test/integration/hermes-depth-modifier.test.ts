/**
 * Depth modifier — proves "shorter" / "more" actually steers the
 * answer length, end-to-end. The MockLLMAdapter inspects the system
 * prompt and returns a long-form answer if it sees the deep cue, a
 * short-form answer if it sees the tldr cue, and a default-form
 * otherwise. That way the test asserts on actual length differences,
 * not just "the right tier was sent."
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter, type LLMRequest } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-depth';
let h: TetherlineHarness;

const SHORT_REPLY = 'It is the capture pipeline.';
const NORMAL_REPLY = 'It is the capture pipeline. Each request goes through an idempotency guard. The store keeps recent keys in memory.';
const DEEP_REPLY = 'It is the capture pipeline. Each request goes through an idempotency guard before any side effects. The store keeps recent keys in memory and reuses prior results when the same key is replayed. This means a network retry never double-charges, even under flapping connections. The guard is enforced in capture.ts at the entry point. Other modules call into capture rather than touching the store directly. The pattern keeps idempotency invariants in one file.';

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'a', description: 'd', commitHashes: [], significance: 'minor', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'A multi-module fixture.', purpose: 'Depth test.', techStack: [], keyAreas: [], conceptualSteps: [{ icon: '🧱', title: 'a', description: 'd' }] });
  m.onTool('classify_intent', { skillName: 'navigate', confidence: 0.8, params: { direction: 'next' } });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'd' }] });
  m.onTool('summarize_files', { summaries: [] });

  // Q&A path returns different lengths based on the depth cue threaded
  // into the system prompt by buildQAContext. This gives us a
  // deterministic "did the cue make it through" signal.
  m.on(
    (req: LLMRequest) => !req.tool && req.system.includes('user asked for short answers'),
    { text: SHORT_REPLY },
  );
  m.on(
    (req: LLMRequest) => !req.tool && req.system.includes('user asked for depth'),
    { text: DEEP_REPLY },
  );
  m.on(
    (req: LLMRequest) => !req.tool,
    { text: NORMAL_REPLY },
  );
  return m;
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => { await h?.stop(); });

async function settle(devSessionId: string) {
  await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'WRAP_UP', 'AREA_WALKTHROUGH'], 45_000);
  if ((await h.client.getSession(devSessionId)).state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function askAndCaptureReply(devSessionId: string, question: string): Promise<string> {
  // Bypass the intent classifier and route directly to handleQuestion.
  // The depth-detection logic lives there, so this still exercises the
  // full path under test — but without skill-dispatch noise.
  const startIdx = (await h.client.events(devSessionId)).events.length;
  await h.client.ask(devSessionId, question);
  await new Promise(r => setTimeout(r, 300));
  const newEvents = (await h.client.events(devSessionId)).events.slice(startIdx);
  const greeting = newEvents.find(e => e.type === 'narration:greeting') as any;
  if (greeting) return greeting.payload.text;
  const chunks = newEvents.filter(e => e.type === 'narration:stream_chunk');
  return chunks.map(c => (c as any).payload.text).join(' ');
}

describe('Hermes — depth modifier really shrinks/expands the reply', () => {
  it('default question → normal-length reply; "shorter" → measurably shorter; "more" → longer', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30,
    });
    await settle(devSessionId);

    const normal = await askAndCaptureReply(devSessionId, 'what is the capture pipeline?');
    expect(normal).toBe(NORMAL_REPLY);

    // Tier change → ack-prefix is prepended as the first stream chunk.
    // The actual answer body is the LAST chunk, so we assert content
    // separately from the ack and compare body lengths.
    const shorter = await askAndCaptureReply(devSessionId, 'shorter — what is the capture pipeline?');
    expect(shorter).toContain("keep it short");
    expect(shorter).toContain(SHORT_REPLY);
    expect(shorter).not.toContain(DEEP_REPLY);

    const longer = await askAndCaptureReply(devSessionId, 'more detail — what is the capture pipeline?');
    expect(longer).toContain('going deeper');
    expect(longer).toContain(DEEP_REPLY);
    // Body length comparison: strip the ack from the longer reply, then
    // check it actually exceeds the normal reply's body.
    const longerBody = longer.replace(/^.*?going deeper\.\s*/, '');
    expect(longerBody.length).toBeGreaterThan(normal.length);
  }, 60_000);

  it('depth tier sticks across follow-ups within the same session', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30,
    });
    await settle(devSessionId);

    // Set tier to tldr — the first reply has the ack-prefix.
    const r1 = await askAndCaptureReply(devSessionId, 'shorter — what is this?');
    expect(r1).toContain('keep it short');
    expect(r1).toContain(SHORT_REPLY);
    // Follow-up with no modifier should still be tldr — but no ack
    // (the tier didn't *change*, it's still tldr from the prior turn).
    const r2 = await askAndCaptureReply(devSessionId, 'and the auth module?');
    expect(r2).toBe(SHORT_REPLY);
    expect(r2).not.toContain('keep it short');
  }, 60_000);
});

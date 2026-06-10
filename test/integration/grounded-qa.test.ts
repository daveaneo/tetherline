/**
 * Grounded Q&A end-to-end:
 *  (a) the answer prompt carries REAL file contents (README verbatim) plus
 *      the ground-truth instructions — the anti-hallucination plumbing;
 *  (b) on a docs-only repo the retrieval confidence is anchors-only →
 *      after the answer, the manager offers "want me to dig through the
 *      code?" and an affirmative escalates;
 *  (c) explicit "dig through the code" phrases route to the agentic path
 *      (spoken buffer + qa.route trace); in cloud mode that degrades to
 *      the spoken caveat + retrieval answer — never silence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter, type LLMRequest } from '../../packages/backend/src/intelligence/llm/index.js';
import { ESCALATION_OFFER, AGENTIC_BUFFER_LINE } from '../../packages/backend/src/session/qa-router.js';

const DOCS_FIXTURE = '/tmp/tetherline-fixture-docs-only';
const SENTINEL = 'QUETZAL-ANCHOR-7341';
let h: TetherlineHarness;
let mock: MockLLMAdapter;

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'docs', description: 'doc updates', commitHashes: [], significance: 'minor', theme: 'docs' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('detect_modules', { modules: [] });
  m.onTool('summarize_files', { summaries: [] });
  m.onTool('project_overview', { overview: 'Docs-only fixture.', purpose: 'Grounding test.', techStack: [], keyAreas: [], conceptualSteps: [] });
  m.onTool('classify_intent', { skillName: 'none', confidence: 0.8, params: {} });
  m.on(req => !req.tool, { text: "I don't see any installation steps in the repo. The readme only covers what the project does." });
  return m;
}

type AnyEvent = { type: string; payload?: any };

async function waitFor(devSessionId: string, since: number, pred: (e: AnyEvent) => boolean, timeoutMs = 10_000): Promise<AnyEvent> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const evs = (await h.client.events(devSessionId, since)).events as AnyEvent[];
    const found = evs.find(pred);
    if (found) return found;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for event');
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-docs-only-repo.sh') + ' ' + DOCS_FIXTURE, { stdio: 'inherit' });
  mock = buildMock();
  h = await tetherline.start({ mock });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('grounded Q&A', () => {
  it('injects real README content + ground-truth instructions into the answer prompt, then offers the deep scan on anchors-only', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: DOCS_FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PREVIOUSLY_ON', 'HEATMAP', 'WRAP_UP'], 45_000);
    const startIdx = (await h.client.events(devSessionId)).events.length;
    const callsBefore = mock.getCalls().length;

    void h.client.utter(devSessionId, 'so how do I install this thing on my machine');
    await waitFor(devSessionId, startIdx, e => e.type === 'narration:stream_chunk' && e.payload.isFinal);

    // (a) The answer LLM saw the REAL readme + grounding instructions.
    const answerReq = mock.getCalls().slice(callsBefore).find((r: LLMRequest) => !r.tool);
    expect(answerReq, 'no answer LLM request captured').toBeTruthy();
    const promptText = JSON.stringify(answerReq);
    expect(promptText).toContain(SENTINEL);
    expect(promptText).toContain('Repository files (ground truth)');
    expect(promptText).toContain('Never invent');

    // (b) anchors-only → spoken offer + armed escalation.
    const offer = await waitFor(devSessionId, startIdx, e => e.type === 'narration:greeting' && e.payload?.text === ESCALATION_OFFER);
    expect(offer).toBeTruthy();

    // Affirmative escalates: buffer line + (cloud mode) caveat + answer.
    const idx2 = (await h.client.events(devSessionId)).events.length;
    void h.client.utter(devSessionId, 'yes');
    const buffer = await waitFor(devSessionId, idx2, e => e.type === 'narration:stream_chunk' && e.payload.text === AGENTIC_BUFFER_LINE);
    expect(buffer.payload.seq).toBe(0);
    await waitFor(devSessionId, idx2, e => e.type === 'narration:stream_chunk' && /can't run a deep scan/.test(e.payload.text ?? ''));
    await waitFor(devSessionId, idx2, e => e.type === 'narration:stream_chunk' && e.payload.isFinal);
  }, 60_000);

  it('explicit "dig through the code" routes to the agentic path with a spoken buffer and qa.route trace', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: DOCS_FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PREVIOUSLY_ON', 'HEATMAP', 'WRAP_UP'], 45_000);
    const startIdx = (await h.client.events(devSessionId)).events.length;

    void h.client.utter(devSessionId, 'dig through the code and tell me how the dedupe works');
    const buffer = await waitFor(devSessionId, startIdx, e => e.type === 'narration:stream_chunk' && e.payload.text === AGENTIC_BUFFER_LINE);
    expect(buffer.payload.seq).toBe(0);
    await waitFor(devSessionId, startIdx, e => e.type === 'narration:stream_chunk' && e.payload.isFinal);

    const { events: traceEvents } = await h.client.trace({ limit: 200 });
    const routes = traceEvents.filter(e => e.kind === 'qa.route').map(e => (e.payload as any)?.route);
    expect(routes).toContain('agentic');
  }, 60_000);

  it('classifier-extracted targets pull the matching file into skill prompts too', async () => {
    // The analyzer path (skills) shares the retriever — verify via a
    // direct ask (none-route) that mentions the vision doc by name.
    const { devSessionId } = await h.client.startSession({ repoPath: DOCS_FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PREVIOUSLY_ON', 'HEATMAP', 'WRAP_UP'], 45_000);
    const callsBefore = mock.getCalls().length;
    const startIdx = (await h.client.events(devSessionId)).events.length;

    void h.client.utter(devSessionId, 'what does the vision doc actually say');
    await waitFor(devSessionId, startIdx, e => e.type === 'narration:stream_chunk' && e.payload.isFinal);

    const answerReq = mock.getCalls().slice(callsBefore).find((r: LLMRequest) => !r.tool);
    const promptText = JSON.stringify(answerReq);
    // Keyword scoring should have matched VISION.md by stem.
    expect(promptText).toContain('Local-first personal fine-tuning');
  }, 60_000);
});

/**
 * Artifact pipeline end-to-end: an answer containing a ```bash fence must
 * (1) emit exactly one visual:artifact with the fence body,
 * (2) speak ZERO backticks — no chunk text contains fence markers or code,
 * (3) speak a replacement line ("on screen") instead.
 * Covers both the streaming QA path and the batch (skill narration) path.
 *
 * Live bug 2026-06-09: the AI read the install script ALOUD, ```bash
 * fences included, while the caption showed it as one unselectable line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter, type LLMRequest } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-artifact';
let h: TetherlineHarness;

const Q_STREAM = 'give me the commands to install this project';
const Q_SKILL = 'explain the capture area please';

const STREAM_ANSWER =
  'Setup is quick. Run these.\n' +
  '```bash\ngit clone https://example.com/repo\ncd repo\nnpm install\n```\n' +
  'REFS: none';

const SKILL_ANSWER =
  'The capture area records audio. Here is how you run it.\n' +
  '```bash\npnpm dev\n```\n' +
  'It hot-reloads on change.';

function msgText(req: LLMRequest): string {
  return JSON.stringify(req.messages);
}

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'capture', description: 'd', commitHashes: [], significance: 'minor', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'A fixture.', purpose: 'Artifact test.', techStack: [], keyAreas: [], conceptualSteps: [{ icon: '🧱', title: 'a', description: 'd' }] });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'd' }] });
  m.onTool('summarize_files', { summaries: [] });
  m.on(
    req => req.tool?.name === 'classify_intent' && msgText(req).includes(Q_SKILL),
    { toolInput: { skillName: 'explain', confidence: 0.95, params: { target: 'capture' } } },
  );
  m.on(
    req => req.tool?.name === 'classify_intent',
    { toolInput: { skillName: 'none', confidence: 0.8, params: {} } },
  );
  // Streamed QA answer: deltas split mid-fence to exercise the holdback.
  m.onTextStream(
    req => !req.tool && msgText(req).includes(Q_STREAM),
    ['Setup is quick. Run these.\n``', '`bash\ngit clone https://example.com/repo\ncd repo\nnpm install\n``', '`\nREFS: none'],
    30,
  );
  m.on(req => !req.tool && msgText(req).includes('capture'), { text: SKILL_ANSWER });
  m.on(req => !req.tool, { text: 'Generic reply sentence.' });
  return m;
}

async function settle(devSessionId: string) {
  await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'WRAP_UP', 'AREA_WALKTHROUGH'], 45_000);
  if ((await h.client.getSession(devSessionId)).state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    await new Promise(r => setTimeout(r, 100));
  }
}

type AnyEvent = { type: string; payload?: any };

async function waitForFinalChunk(devSessionId: string, since: number, timeoutMs = 15_000): Promise<AnyEvent[]> {
  const t0 = Date.now();
  for (;;) {
    const evs = (await h.client.events(devSessionId, since)).events as AnyEvent[];
    if (evs.some(e => e.type === 'narration:stream_chunk' && e.payload.isFinal)) return evs;
    if (Date.now() - t0 > timeoutMs) throw new Error('no final chunk');
    await new Promise(r => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('artifact pipeline — fenced code goes to the screen, never the voice', () => {
  it('streaming QA: one visual:artifact, zero spoken backticks, replacement line spoken', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const startIdx = (await h.client.events(devSessionId)).events.length;

    void h.client.utter(devSessionId, Q_STREAM);
    const evs = await waitForFinalChunk(devSessionId, startIdx);

    const artifacts = evs.filter(e => e.type === 'visual:artifact');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].payload.kind).toBe('commands');
    expect(artifacts[0].payload.language).toBe('bash');
    expect(artifacts[0].payload.body).toBe('git clone https://example.com/repo\ncd repo\nnpm install');

    const chunkTexts = evs
      .filter(e => e.type === 'narration:stream_chunk')
      .map(e => String(e.payload.text));
    for (const t of chunkTexts) {
      expect(t, `spoken chunk must not contain backticks: "${t}"`).not.toContain('`');
      expect(t).not.toContain('git clone');
    }
    expect(chunkTexts.some(t => /on (the |your )?screen/i.test(t)), 'replacement line spoken').toBe(true);
  }, 60_000);

  it('batch skill path: same trio through emitNarrationChunked', async () => {
    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const startIdx = (await h.client.events(devSessionId)).events.length;

    void h.client.utter(devSessionId, Q_SKILL);
    const evs = await waitForFinalChunk(devSessionId, startIdx, 20_000);

    const artifacts = evs.filter(e => e.type === 'visual:artifact');
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    expect(artifacts[0].payload.body).toContain('pnpm dev');

    const chunkTexts = evs
      .filter(e => e.type === 'narration:stream_chunk')
      .map(e => String(e.payload.text));
    for (const t of chunkTexts) {
      expect(t, `spoken chunk must not contain backticks: "${t}"`).not.toContain('`');
      expect(t).not.toContain('pnpm dev');
    }

    // Deviation-nudge regression: a skill turn must never stack the
    // tour nudge onto its own answer (live bug: streamed skills carried
    // narration:'' and were misread as "silent", so 'say "back to the
    // tour"' played right after the answer — and later echo-executed).
    const nudges = evs.filter(e =>
      e.type === 'narration:greeting' && /back to the tour/i.test(String(e.payload?.text ?? '')));
    expect(nudges).toHaveLength(0);
  }, 60_000);
});

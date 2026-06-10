/**
 * Precompiled flows + jump-to-flow (2026-06-10 live note #3: "flows should be
 * pre-compiled at load, and asking about core should jump straight into it").
 *
 *  - warmDiagrams authors a grounded flow per top module → flow/module/* rows;
 *    a second warm with the same evidence does NOT re-call the LLM (sourceHash).
 *  - "tell me about core" delivers the briefing AND surfaces the precompiled
 *    flow as a visualize-shaped skill:result (scope flow/module/core).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';
import { warmDiagrams } from '../../packages/backend/src/intelligence/diagram-warmer.js';

const FIXTURE = '/tmp/tetherline-fixture-flow-precompile';
let h: TetherlineHarness;

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'core', description: 'd', commitHashes: [], significance: 'minor', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'A fixture.', purpose: 'Flow test.', techStack: [], keyAreas: [], conceptualSteps: [] });
  m.onTool('detect_modules', { modules: [{ name: 'core', pathPrefixes: ['core'], description: 'd' }] });
  m.onTool('summarize_files', { summaries: [] });
  m.onTool('classify_intent', { skillName: 'none', confidence: 0.8, params: {} });
  m.on(req => !req.tool, { text: 'Generic.' });
  return m;
}

const CORE_FILES = ['core/web_collector.py', 'core/data_cleaner.py', 'core/pair_generator.py'];

function seedModule() {
  h.server.db.getContextCacheRepo().upsertModule({
    repoPath: FIXTURE, modulePath: 'core', summary: 'Core ingestion pipeline.',
    source: 'heuristic', keyFiles: CORE_FILES, imports: [], confidence: 0.9, impactScore: 100,
  });
}

/** Mock structured-call analyzer that authors a grounded core flow. */
function makeFlowAnalyzer() {
  let calls = 0;
  return {
    calls: () => calls,
    analyzer: {
      structuredCallDirect: async <T,>(): Promise<T> => {
        calls++;
        return {
          narration: 'WebCollector feeds DataCleaner, which builds PairGenerator pairs.',
          kind: 'pipeline', title: 'Core workflow', subtitle: 'ingest → clean → pair',
          nodes: [
            { id: 'wc', label: 'WebCollector', role: 'source', evidenceFile: 'core/web_collector.py' },
            { id: 'dc', label: 'DataCleaner', role: 'transform', evidenceFile: 'core/data_cleaner.py' },
            { id: 'pg', label: 'PairGenerator', role: 'sink', evidenceFile: 'core/pair_generator.py' },
          ],
          edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }],
        } as unknown as T;
      },
    },
  };
}

function seedBriefings() {
  const base = { sourceHash: 'h', cachedAt: new Date().toISOString() };
  const repo = h.server.db.getBriefingRepo();
  repo.upsert({ ...base, repoPath: FIXTURE, id: 'project', layer: 'project', title: 'fixture', opener: 'A fixture with core.', talkingPoints: [], children: ['module/core'], parent: null, visualCue: { kind: 'none' }, estimatedSeconds: 10 });
  repo.upsert({ ...base, repoPath: FIXTURE, id: 'module/core', layer: 'module', title: 'core', opener: 'Core ingests and cleans data.', talkingPoints: [], children: [], parent: 'project', visualCue: { kind: 'diagram_focus', ref: 'core' }, estimatedSeconds: 10 });
}

type AnyEvent = { type: string; payload?: any };

async function settle(devSessionId: string) {
  await h.client.waitForAnyPhase(devSessionId, ['PROPOSAL', 'OVERVIEW', 'WRAP_UP', 'AREA_WALKTHROUGH'], 45_000);
  if ((await h.client.getSession(devSessionId)).state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    await new Promise(r => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  fs.mkdirSync(path.join(FIXTURE, 'core'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE, 'core/web_collector.py'), 'import requests\n');
  fs.writeFileSync(path.join(FIXTURE, 'core/data_cleaner.py'), 'from core.web_collector import WebCollector\n');
  fs.writeFileSync(path.join(FIXTURE, 'core/pair_generator.py'), 'from core.data_cleaner import DataCleaner\n');
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('flow precompile + jump-to-flow', () => {
  it('warms a grounded flow per top module, then skips on the second run', async () => {
    seedModule();
    const fa = makeFlowAnalyzer();
    const db = h.server.db;
    await warmDiagrams(FIXTURE, db.getContextCacheRepo(), db.getDiagramCacheRepo(), db.getComprehensionRepo(), null, undefined, fa.analyzer as any);

    const row = db.getDiagramCacheRepo().get(FIXTURE, 'flow/module/core', 'logic');
    expect(row, 'flow row written').toBeTruthy();
    expect(row!.nodes.length).toBeGreaterThanOrEqual(3);
    expect(row!.narration).toMatch(/WebCollector|DataCleaner|PairGenerator/);
    const callsAfterFirst = fa.calls();
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second warm with identical evidence → sourceHash match → no LLM re-call.
    await warmDiagrams(FIXTURE, db.getContextCacheRepo(), db.getDiagramCacheRepo(), db.getComprehensionRepo(), null, undefined, fa.analyzer as any);
    expect(fa.calls(), 'unchanged evidence must not re-author').toBe(callsAfterFirst);
  }, 60_000);

  it('"tell me about core" surfaces the precompiled flow as a skill:result', async () => {
    seedModule();
    seedBriefings();
    // Ensure a flow row exists (warm it if the prior test didn't).
    const db = h.server.db;
    if (!db.getDiagramCacheRepo().get(FIXTURE, 'flow/module/core', 'logic')) {
      const fa = makeFlowAnalyzer();
      await warmDiagrams(FIXTURE, db.getContextCacheRepo(), db.getDiagramCacheRepo(), db.getComprehensionRepo(), null, undefined, fa.analyzer as any);
    }

    const { devSessionId } = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    await settle(devSessionId);
    const startIdx = (await h.client.events(devSessionId)).events.length;

    await h.client.utter(devSessionId, 'tell me about core');

    const t0 = Date.now();
    let surfaced: AnyEvent | undefined;
    while (Date.now() - t0 < 6000) {
      surfaced = ((await h.client.events(devSessionId, startIdx)).events as AnyEvent[])
        .find(e => e.type === 'skill:result' && e.payload?.result?.skillName === 'visualize'
          && e.payload?.result?.visualPayload?.diagram?.scope === 'flow/module/core');
      if (surfaced) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(surfaced, 'the precompiled core flow must auto-surface after the briefing').toBeTruthy();
    expect(surfaced!.payload.result.visualPayload.kind).toBe('pipeline');
  }, 60_000);
});

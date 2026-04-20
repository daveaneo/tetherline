import { describe, it, expect, afterAll, beforeAll } from 'vitest';
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
  mock.onTool('detect_modules', { modules: [] });
  mock.onTool('summarize_files', { summaries: [] });
  mock.onTool('classify_intent', { skillName: 'navigate', confidence: 0.9, params: {} });
  mock.on((req) => !req.tool, { text: '' });
  return mock;
}

describe('S11/S13/S14 — review mode, multi-repo, share', () => {
  let h: TetherlineHarness;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });

    // Seed briefings + a couple of comprehension items
    const repo = h.server.db.getBriefingRepo();
    const base = { sourceHash: 'h', cachedAt: new Date().toISOString() };
    repo.upsert({
      ...base, repoPath: FIXTURE, id: 'project', layer: 'project', title: 'fixture',
      opener: 'Fixture project. Tiny test repo used by Tetherline integration tests.',
      talkingPoints: ['two modules', 'deterministic commits'],
      children: [], parent: null,
      visualCue: { kind: 'none' }, estimatedSeconds: 8,
    });
    h.server.db.getComprehensionRepo().upsert({
      repoPath: FIXTURE, itemId: 'project', layer: 'project', label: 'fixture',
      level: 'confirmed', narrationSecondsHeard: 8, questionsAsked: 1,
      lastTouchedAt: new Date().toISOString(), lastSessionId: 'test',
    });
    h.server.db.getComprehensionRepo().upsert({
      repoPath: FIXTURE, itemId: 'module/core', layer: 'module', label: 'core',
      level: 'explained', narrationSecondsHeard: 6, questionsAsked: 0,
      lastTouchedAt: new Date().toISOString(), lastSessionId: 'test',
    });
  });

  afterAll(async () => { await h?.stop(); });

  it('S11 — review endpoint returns full comprehension map outside a session', async () => {
    const map = await h.client.comprehension(FIXTURE);
    expect(map.items).toHaveLength(2);
    expect(map.totals.confirmed).toBe(1);
    expect(map.totals.explained).toBe(1);
  });

  it('S13 — multi-repo map returns one entry per repo path, in order', async () => {
    const res = await h.client.comprehensionMulti([FIXTURE, '/fake/other-repo']);
    expect(res.maps).toHaveLength(2);
    expect(res.maps[0].repoPath).toBe(FIXTURE);
    expect(res.maps[0].items).toHaveLength(2);
    expect(res.maps[1].items).toHaveLength(0);
  });

  it('S14 — share endpoint renders a standalone HTML page for a briefing', async () => {
    const response = await fetch(
      `${h.server.baseUrl}/api/dev/briefing/share?repoPath=${encodeURIComponent(FIXTURE)}&id=project`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toMatch(/Fixture project/);
    expect(html).toMatch(/deterministic commits/);  // talking points
  });

  it('S14 — share endpoint escapes user-generated content', async () => {
    const repo = h.server.db.getBriefingRepo();
    const base = { sourceHash: 'h', cachedAt: new Date().toISOString() };
    repo.upsert({
      ...base, repoPath: FIXTURE, id: 'module/with<script>', layer: 'module',
      title: 'Has <script> and "quotes"',
      opener: 'This briefing has <script>alert(1)</script> embedded to test escaping.',
      talkingPoints: [], children: [], parent: null,
      visualCue: { kind: 'none' }, estimatedSeconds: 5,
    });
    const response = await fetch(
      `${h.server.baseUrl}/api/dev/briefing/share?repoPath=${encodeURIComponent(FIXTURE)}&id=${encodeURIComponent('module/with<script>')}`,
    );
    const html = await response.text();
    expect(html).not.toMatch(/<script>alert/);        // must not render raw
    expect(html).toMatch(/&lt;script&gt;alert/);      // must be escaped
  });

  it('S14 — share 404s when briefing id is unknown', async () => {
    const response = await fetch(
      `${h.server.baseUrl}/api/dev/briefing/share?repoPath=${encodeURIComponent(FIXTURE)}&id=does-not-exist`,
    );
    expect(response.status).toBe(404);
  });
});

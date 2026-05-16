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

function seedBriefings(h: TetherlineHarness) {
  const base = { sourceHash: 'h', cachedAt: new Date().toISOString() };
  const repo = h.server.db.getBriefingRepo();
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'project', layer: 'project', title: 'fixture',
    opener: 'This is the project briefing. It explains what the project does at a high level.',
    talkingPoints: [], children: ['arch/root', 'module/core'], parent: null,
    visualCue: { kind: 'none' }, estimatedSeconds: 8,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'arch/root', layer: 'architecture', title: 'Architecture',
    opener: 'Two modules: core and utils. Start with core.',
    talkingPoints: [], children: ['module/core'], parent: 'project',
    visualCue: { kind: 'diagram_focus' }, estimatedSeconds: 6,
  });
  repo.upsert({
    ...base, repoPath: FIXTURE, id: 'module/core', layer: 'module', title: 'core',
    opener: 'Core handles capture and idempotency. Retries never double-charge.',
    talkingPoints: [], children: [], parent: 'arch/root',
    visualCue: { kind: 'diagram_focus', ref: 'core' }, estimatedSeconds: 6,
  });
}

describe('S8/S9 — comprehension tracking', () => {
  let h: TetherlineHarness;
  let sid: string;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
    seedBriefings(h);
    const started = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30 });
    sid = started.devSessionId;
    await new Promise(r => setTimeout(r, 100));
  });

  afterAll(async () => { await h?.stop(); });

  it('project briefing delivered at session start marks project item as heard', async () => {
    // Hearing a briefing only earns 'heard' — the depth lock that prevents
    // passive consumption from inflating into 'explained' / 'confirmed'.
    // Quiz / confirmation phrases are how the user actively earns deeper levels.
    const map = await h.client.comprehension(FIXTURE);
    const project = map.items.find(i => i.itemId === 'project');
    expect(project).toBeTruthy();
    expect(project!.level).toBe('heard');
    expect(project!.layer).toBe('project');
  });

  it('drilling into a module marks it as heard', async () => {
    await h.client.utter(sid, 'walk me through the architecture');
    await h.client.utter(sid, 'tell me about core');
    const map = await h.client.comprehension(FIXTURE);
    const core = map.items.find(i => i.itemId === 'module/core');
    expect(core).toBeTruthy();
    expect(core!.level).toBe('heard');
  });

  it('confirmation phrase within window upgrades to confirmed', async () => {
    // Just delivered module/core in previous test — still within window.
    const before = (await h.client.events(sid)).total;
    await h.client.utter(sid, 'got it');
    const { events } = await h.client.events(sid, before);
    const upgrade = events.find(e => e.type === 'comprehension:updated') as any;
    expect(upgrade).toBeTruthy();
    expect(upgrade.payload.itemId).toBe('module/core');
    expect(upgrade.payload.level).toBe('confirmed');
    expect(upgrade.payload.reason).toBe('confirmed_phrase');

    const map = await h.client.comprehension(FIXTURE);
    expect(map.items.find(i => i.itemId === 'module/core')!.level).toBe('confirmed');
  });

  it('confirmation phrase in the middle of a longer utterance does NOT confirm', async () => {
    // "got it, now tell me about utils" — "got it" is present but it's a transition,
    // not a confirmation. The isConfirmationPhrase() check guards this.
    await h.client.utter(sid, 'walk me through the architecture'); // re-push arch
    const before = (await h.client.events(sid)).total;
    await h.client.utter(sid, 'got it, now tell me about utils');
    const { events } = await h.client.events(sid, before);
    // arch/root's level should NOT have jumped to confirmed — long utterance doesn't match
    const confirmedUpgrade = events.find(e =>
      e.type === 'comprehension:updated' && (e as any).payload.level === 'confirmed');
    expect(confirmedUpgrade).toBeFalsy();
  });

  it('passive confirmation does NOT set the separate grill QA proof', async () => {
    // module/core reached 'confirmed' via the "got it" phrase above.
    // `grilled` is a SEPARATE active-recall proof — it must stay false.
    const map = await h.client.comprehension(FIXTURE);
    const core = map.items.find(i => i.itemId === 'module/core')!;
    expect(core.level).toBe('confirmed');
    expect(core.grilled === true).toBe(false);
  });

  it('markGrilled flips the QA proof — monotonic and independent of level', () => {
    const repo = h.server.db.getComprehensionRepo();
    const before = repo.get(FIXTURE, 'project')!;
    expect(before.level).toBe('heard');
    expect(before.grilled === true).toBe(false);

    repo.markGrilled(FIXTURE, 'project');
    const grilled = repo.get(FIXTURE, 'project')!;
    expect(grilled.grilled).toBe(true);
    expect(grilled.level).toBe('heard'); // grill proof never changes level

    // A later passive observation must NOT clear the proof, and a lower
    // proposed level must not regress it.
    repo.observe(FIXTURE, 'project', 'project', 'fixture', 'mentioned');
    const after = repo.get(FIXTURE, 'project')!;
    expect(after.grilled).toBe(true);
    expect(after.level).toBe('heard');
  });

  it('totals aggregate correctly across items', async () => {
    const map = await h.client.comprehension(FIXTURE);
    const sum = Object.values(map.totals).reduce((a, b) => a + b, 0);
    expect(sum).toBe(map.items.length);
    expect(map.totals.confirmed).toBeGreaterThanOrEqual(1); // module/core was confirmed
  });

  it('multi-repo map returns one entry per repo', async () => {
    const res = await h.client.comprehensionMulti([FIXTURE, '/nonexistent']);
    expect(res.maps).toHaveLength(2);
    expect(res.maps[0].repoPath).toBe(FIXTURE);
    expect(res.maps[1].items).toEqual([]);
  });
});

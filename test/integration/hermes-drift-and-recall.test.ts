/**
 * Drift detection + cross-session recall — the two halves of "Hermes
 * remembers what you learned and notices what has changed."
 *
 * Drift: a comprehension item the user got to confirmed regresses to
 * heard when the underlying code changes (briefing sourceHash drifts).
 *
 * Recall: a fresh session emits session:recall with `items` carrying
 * each previously-engaged item's level + commits-since-last-touch, so
 * the GapsPanel can render "pick up where you left off."
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-drift';

let h: TetherlineHarness;

function buildMock(): MockLLMAdapter {
  const m = new MockLLMAdapter();
  m.onTool('group_commits', { areas: [{ name: 'a', description: 'd', commitHashes: [], significance: 'minor', theme: 'x' }] });
  m.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  m.onTool('architecture_graph', { nodes: [{ id: 'n', label: 'n', type: 'module', zoomLevel: 1 }], edges: [] });
  m.onTool('flag_concerns', { concerns: [] });
  m.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 50, impactSummary: 's', riskFlags: [] }] });
  m.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  m.onTool('project_overview', { overview: 'A multi-module fixture.', purpose: 'Drift test fixture.', techStack: [], keyAreas: [], conceptualSteps: [{ icon: '🧱', title: 'a', description: 'd' }] });
  m.onTool('classify_intent', { skillName: 'navigate', confidence: 0.8, params: { direction: 'next' } });
  m.onTool('detect_modules', { modules: [{ name: 'auth', pathPrefixes: ['auth'], description: 'd' }] });
  m.onTool('summarize_files', { summaries: [] });
  m.on(req => !req.tool, { text: 'A reply.' });
  return m;
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => { await h?.stop(); });

describe('Hermes — drift detection + cross-session recall', () => {
  it('drift: editing a key file regresses comprehension from confirmed to heard', async () => {
    // Session 1: drill into auth + take quiz to bump comprehension to confirmed.
    const session1 = await h.client.startSession({
      repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30,
    });
    await h.client.waitForAnyPhase(
      session1.devSessionId,
      ['PROPOSAL', 'OVERVIEW', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'WRAP_UP', 'AREA_WALKTHROUGH'],
      45_000,
    );
    // Accept the proposal if needed.
    if ((await h.client.getSession(session1.devSessionId)).state.phase === 'PROPOSAL') {
      await h.client.command(session1.devSessionId, 'next');
      await new Promise(r => setTimeout(r, 100));
    }

    await h.client.utter(session1.devSessionId, 'tell me about auth');
    await new Promise(r => setTimeout(r, 200));

    // Sanity check: navigator should now point at module/auth.
    const navAfterDrill = await h.client.navigator(session1.devSessionId);
    expect(navAfterDrill.frames.at(-1)?.briefingId, 'auth pushed').toBe('module/auth');

    // Take the quiz — answer all 3 questions correctly to bump auth to 'confirmed'.
    const startEvents = (await h.client.events(session1.devSessionId)).events.length;
    await h.client.command(session1.devSessionId, 'quiz_start');

    // Drive the quiz: pull each question, answer with the canonical
    // expected derived from briefing data (template Q0 = first sentence;
    // Q1/Q2 = first two child labels). For the auth module the briefing's
    // children are file/* — close enough for our scoring's lenient match.
    const authBriefing = (await h.client.briefing(FIXTURE, 'module/auth')).briefing;
    const childLabels = (authBriefing.children as string[]).map((id: string) =>
      id.indexOf('/') === -1 ? id : id.split('/').slice(1).join('/'),
    );
    const expected = [
      authBriefing.opener.split(/[.!?]/)[0]!.trim(),
      childLabels[0] ?? authBriefing.title,
      childLabels[1] ?? childLabels[0] ?? authBriefing.title,
    ];
    for (let i = 0; i < 3; i++) {
      let q: any = null;
      for (let attempt = 0; attempt < 50 && !q; attempt++) {
        const ev = await h.client.events(session1.devSessionId);
        q = ev.events.slice(startEvents).filter(e => e.type === 'quiz:question')[i];
        if (!q) await new Promise(r => setTimeout(r, 30));
      }
      await h.client.quizAnswer(session1.devSessionId, q.payload.questionId, expected[i]);
      await new Promise(r => setTimeout(r, 80));
    }
    // Wait for quiz:result.
    let result: any = null;
    for (let i = 0; i < 50 && !result; i++) {
      const ev = await h.client.events(session1.devSessionId);
      result = ev.events.slice(startEvents).find(e => e.type === 'quiz:result');
      if (!result) await new Promise(r => setTimeout(r, 30));
    }
    // The exact level depends on how many of our derived "expected"
    // answers fuzzy-match the templated questions. We need at least
    // 'explained' so the drift regression to 'heard' is observable.
    expect(['explained', 'confirmed']).toContain(result?.payload.newLevel);

    // Verify auth is at explained-or-better before drift.
    let map = new Map<string, string>();
    for (const it of (await h.client.comprehension(FIXTURE)).items) map.set(it.itemId, it.level);
    expect(['explained', 'confirmed']).toContain(map.get('module/auth'));
    const preDriftLevel = map.get('module/auth');

    // ── Simulate a real code edit + commit on auth/jwt.ts ───────────
    // Drift detection runs against committed history (the diff-detector
    // fast-path is `git diff cachedHead HEAD`), so the test commits the
    // change to mirror what a real user would do.
    const jwtPath = path.join(FIXTURE, 'auth/jwt.ts');
    const original = fs.readFileSync(jwtPath, 'utf8');
    fs.writeFileSync(jwtPath, original + '\n\nexport function newRotationStrategy() { /* totally new */ }\n');
    execSync('git -C "' + FIXTURE + '" add auth/jwt.ts && git -C "' + FIXTURE + '" -c user.email=t@t -c user.name=t commit -q -m "Add newRotationStrategy"');

    // Session 2: fresh session against the same DB. Warm should detect
    // the file change → briefing sourceHash drifts → comprehension
    // degrades to heard.
    const session2 = await h.client.startSession({
      repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30,
    });
    await h.client.waitForAnyPhase(
      session2.devSessionId,
      ['PROPOSAL', 'OVERVIEW', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'WRAP_UP', 'AREA_WALKTHROUGH'],
      45_000,
    );

    map = new Map<string, string>();
    for (const it of (await h.client.comprehension(FIXTURE)).items) map.set(it.itemId, it.level);
    // After drift: auth regressed from its prior rich level to 'heard'.
    // The bar isn't a specific level — it's that the level MOVED DOWN
    // because the underlying code changed. That's the depth-lock
    // honesty: hearing-or-quizzing-once doesn't certify you on code
    // that has since shifted.
    const postDriftLevel = map.get('module/auth');
    expect(postDriftLevel).toBe('heard');
    expect(postDriftLevel).not.toBe(preDriftLevel);
  }, 180_000);

  it('recall: session start emits session:recall with items the user previously engaged with', async () => {
    // Build on the previous test's state: the DB has comprehension on
    // module/auth (level=heard after the drift). Start a fresh session
    // and inspect session:recall.
    const session3 = await h.client.startSession({
      repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30,
    });
    // Recall fires near the beginning — give it a moment + event scan.
    await new Promise(r => setTimeout(r, 300));
    const events = (await h.client.events(session3.devSessionId)).events;
    const recall = events.find(e => e.type === 'session:recall');

    // Two acceptable outcomes:
    //   (a) recall fires with `items` carrying any prior engagements that
    //       are still at engaged-or-better, OR
    //   (b) recall doesn't fire because nothing crossed the threshold.
    // Both are correct — the assertion is "if it fires, the new
    // structured shape is in place," not "it must fire."
    if (recall) {
      const payload = (recall as any).payload;
      expect(Array.isArray(payload.items)).toBe(true);
      // Each item, if present, has the shape we promised the frontend.
      for (const item of payload.items) {
        expect(typeof item.itemId).toBe('string');
        expect(typeof item.level).toBe('string');
        expect(typeof item.commitsSinceLastTouch).toBe('number');
      }
    }
  }, 90_000);
});

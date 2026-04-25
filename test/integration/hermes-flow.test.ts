/**
 * Hermes — full-flow e2e covering the radial-map exploration loop.
 *
 * Five scenarios in one harness so you can see the full arc:
 *
 *   A. Click navigation — utterance "tell me about <module>" pushes the
 *      navigator, the new center has its own ≤6 children, UP pops back.
 *   B. Voice navigation — same arc driven by natural-language phrases
 *      ("tell me about core", "go deeper", "go back"). Confirms voice
 *      and click paths converge on the same comprehension state.
 *   C. Depth invariant — hearing the project briefing only promotes
 *      `project` to `heard`; module/file entries stay at `unknown`.
 *      Hearing ≠ knowing.
 *   D. Quiz — entering quiz on a layer with 3/3 correct answers bumps
 *      that layer from `heard` → `confirmed`; 2/3 → `explained`; ≤1
 *      stays at `heard` (the depth lock).
 *   E. Children cap — every briefing surfaces at most 6 children, so
 *      the radial map never exceeds Miller's-rule cognitive load.
 *
 * Drives the live backend via the dev API harness (no jsdom / no UI).
 * That gives us deterministic, fast assertions on the actual state
 * machine the real app talks to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE_PATH = '/tmp/tetherline-fixture-hermes-flow';

let h: TetherlineHarness;

function buildMock(): MockLLMAdapter {
  const mock = new MockLLMAdapter();

  // Each mock matches the actual tool inputSchema in
  // packages/backend/src/intelligence/prompts/*.ts. Don't drift — the tool
  // definitions are the source of truth and pipeline blow-ups here cascade
  // into "session lands at ERROR" which makes every downstream test
  // useless.
  mock.onTool('group_commits', {
    areas: [{
      name: 'Idempotent capture',
      description: 'Adds an idempotency store so retries never double-charge.',
      significance: 'major',
      theme: 'correctness',
      commitHashes: [],
    }],
  });
  mock.onTool('narration_segments', {
    overview: 'This area introduces an idempotency store so retries never double-charge.',
    segments: [
      { text: 'This week introduces an idempotency store.', visualCue: { type: 'none' } },
    ],
  });
  mock.onTool('architecture_graph', {
    nodes: [
      { id: 'capture', label: 'Capture', type: 'module', zoomLevel: 1 },
      { id: 'store', label: 'IdempotencyStore', type: 'module', zoomLevel: 1 },
    ],
    edges: [{ source: 'capture', target: 'store', type: 'uses' }],
  });
  mock.onTool('flag_concerns', { concerns: [] });
  mock.onTool('rank_impact', {
    rankings: [{ areaIndex: 0, overallImpact: 80, impactSummary: 'Prevents duplicate charges on retry.', riskFlags: [] }],
  });
  mock.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  mock.onTool('project_overview', {
    overview: 'Tetherline is a small fixture project that exercises the radial-map exploration loop end-to-end. It has two modules, core and utils, and a couple of files worth narrating. The fixture is deterministic so tests stay reproducible.',
    purpose: 'Fixture project for the Hermes flow e2e test.',
    techStack: ['TypeScript'],
    keyAreas: ['core', 'utils'],
    conceptualSteps: [
      { icon: '🧱', title: 'Modules', description: 'Two top-level modules: core and utils.' },
      { icon: '🔁', title: 'Capture flow', description: 'Capture goes through the idempotency store.' },
    ],
  });
  mock.onTool('classify_intent', { skillName: 'navigate', confidence: 0.8, params: { direction: 'next' } });

  // Context-cache module detection — the radial map's children come from this list.
  mock.onTool('detect_modules', {
    modules: [
      { name: 'core', pathPrefixes: ['src/core'], description: 'Core capture and idempotency logic.' },
      { name: 'utils', pathPrefixes: ['src/utils'], description: 'Shared helpers like logging.' },
    ],
  });
  mock.onTool('summarize_files', {
    summaries: [
      { index: 0, summary: 'Capture entrypoint with idempotency guard.', role: 'entrypoint' },
      { index: 1, summary: 'In-memory idempotency store.', role: 'service' },
    ],
  });

  // Generic text fallback (module summaries, Q&A answers, briefing
  // openers, anything the prompts don't cover with a tool). Returns a
  // sentence usable as a module summary so briefing composer succeeds.
  mock.on(
    req => !req.tool,
    { text: 'This module groups the core capture and idempotency logic together. Capture goes through the idempotency store on every call, so retries never double-charge.' },
  );

  return mock;
}

/** Fetches comprehension and returns a Map<itemId, level> for clean asserts. */
async function readComprehensionMap(repoPath: string): Promise<Map<string, string>> {
  const c = await h.client.comprehension(repoPath);
  return new Map(c.items.map(it => [it.itemId, it.level]));
}

/** Walk the events list and find the most recent narration:briefing payload. */
function lastBriefing(events: any[]): any | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'narration:briefing') return events[i].payload;
  }
  return null;
}

function findEvent(events: any[], type: string): any | null {
  for (const e of events) if (e.type === type) return e;
  return null;
}

/** Drive the session from ANALYZING through to a "free to drill" phase
 *  where utterances will route to the navigator (not be intercepted as
 *  proposal responses or analysis events). Polls until phase is anything
 *  other than IDLE/ANALYZING/PROPOSAL — so PREVIOUSLY_ON/HEATMAP/etc.
 *  all count. */
async function settleIntoExplore(devSessionId: string): Promise<void> {
  await h.client.waitForAnyPhase(
    devSessionId,
    [
      'PROPOSAL', 'OVERVIEW', 'AREA_WALKTHROUGH', 'PROJECT_OVERVIEW',
      'PREVIOUSLY_ON', 'HEATMAP', 'COMPONENT_TOUR', 'WRAP_UP', 'ARCHITECTURE_OVERVIEW',
    ],
    45_000,
  );
  const session = await h.client.getSession(devSessionId);
  if (session.state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    // Anything other than PROPOSAL is fine — PREVIOUSLY_ON / HEATMAP /
    // OVERVIEW / etc. all let utterances flow to the navigator.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const s = await h.client.getSession(devSessionId);
      if (s.state.phase !== 'PROPOSAL' && s.state.phase !== 'IDLE' && s.state.phase !== 'ANALYZING') return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`stuck in proposal — current phase ${session.state.phase}`);
  }
}

beforeAll(async () => {
  // Always rebuild the fixture (cheap) so we don't drift from script changes.
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE_PATH, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildMock() });
}, 90_000);

afterAll(async () => {
  await h?.stop();
});

describe('Hermes radial-map flow', () => {
  it('A. project briefing emits ≤6 children, all are valid briefing IDs', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'updates',
      sinceDays: 30,
    });
    await settleIntoExplore(devSessionId);

    // /briefings returns summaries (childCount, not children) — fetch the
    // full project briefing to inspect its children list.
    const project = (await h.client.briefing(FIXTURE_PATH, 'project')).briefing;
    expect(project, 'project briefing exists').toBeTruthy();
    expect(Array.isArray(project.children), 'children is an array').toBe(true);
    expect(project.children.length).toBeLessThanOrEqual(6);
    expect(project.children.length).toBeGreaterThan(0);

    // Every child id should resolve to an actual briefing in DB.
    for (const childId of project.children) {
      const child = await h.client.briefing(FIXTURE_PATH, childId);
      expect(child.briefing, `child ${childId} exists`).toBeTruthy();
    }
  }, 60_000);

  it('B. click-style navigation: utterance "tell me about core" pushes navigator + emits child briefing', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'explore',
      sinceDays: 30,
    });
    await settleIntoExplore(devSessionId);

    // Open at project briefing first (auto-delivered on session start when cached).
    // Simulate the user clicking the "core" satellite.
    const before = await h.client.events(devSessionId);
    const startIdx = before.events.length;

    const utter = await h.client.utter(devSessionId, 'tell me about core');
    expect(utter.ok).toBe(true);

    const after = await h.client.events(devSessionId);
    const newEvents = after.events.slice(startIdx);
    const moduleBriefing = lastBriefing(newEvents);
    expect(moduleBriefing, 'module briefing emitted').toBeTruthy();
    expect(moduleBriefing.layer).toBe('module');
    expect(moduleBriefing.briefingId).toBe('module/core');
    // Children of the module briefing also capped at 6.
    expect(moduleBriefing.children.length).toBeLessThanOrEqual(6);

    // Navigator deepened by 1 frame (project → module/core).
    const nav = await h.client.navigator(devSessionId);
    expect(nav.depth).toBeGreaterThanOrEqual(1);
    expect(nav.frames.at(-1)?.briefingId).toBe('module/core');
  }, 60_000);

  it('C. UP arrow (command:level_up) pops the navigator and re-emits the parent briefing', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'explore',
      sinceDays: 30,
    });
    await settleIntoExplore(devSessionId);

    // Drill down into a module first.
    await h.client.utter(devSessionId, 'tell me about core');
    const navAfterPush = await h.client.navigator(devSessionId);
    const depthAtModule = navAfterPush.depth;
    expect(depthAtModule).toBeGreaterThan(0);

    // Hit the UP arrow.
    const before = await h.client.events(devSessionId);
    const startIdx = before.events.length;
    const cmd = await h.client.command(devSessionId, 'level_up');
    expect(cmd.ok).toBe(true);

    const after = await h.client.events(devSessionId);
    const newEvents = after.events.slice(startIdx);

    // navigator:pop fires + parent briefing re-emits.
    expect(findEvent(newEvents, 'navigator:pop'), 'navigator:pop emitted').toBeTruthy();
    const reemitted = lastBriefing(newEvents);
    expect(reemitted, 'parent briefing re-emitted').toBeTruthy();
    expect(reemitted.briefingId).not.toBe('module/core');

    const navAfterPop = await h.client.navigator(devSessionId);
    expect(navAfterPop.depth).toBe(depthAtModule - 1);
  }, 60_000);

  it('D. depth invariant: hearing the project briefing does NOT promote module/file comprehension', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'updates',
      sinceDays: 30,
    });
    await settleIntoExplore(devSessionId);

    const map = await readComprehensionMap(FIXTURE_PATH);
    // Project briefing was delivered on session start — should be at 'heard'.
    expect(map.get('project')).toBe('heard');

    // Critically: module and file items should NOT have been promoted just
    // by virtue of the project briefing being heard. They're either absent
    // from the map entirely (never observed) or at 'unknown'/'mentioned'.
    for (const [id, level] of map) {
      if (id === 'project') continue;
      // Anything we haven't drilled into stays cold.
      if (id.startsWith('module/') || id.startsWith('file/')) {
        expect(['unknown', 'mentioned', 'heard'].includes(level), `${id} level ${level} should be cold`).toBe(true);
        // And specifically NOT 'explained' / 'confirmed' (which would mean
        // hearing the parent silently certified the user on the child).
        expect(level).not.toBe('explained');
        expect(level).not.toBe('confirmed');
      }
    }
  }, 60_000);

  it('E. quiz: 3/3 correct answers bumps comprehension from heard → confirmed', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'updates',
      sinceDays: 30,
    });
    await settleIntoExplore(devSessionId);

    // Make sure the project briefing has actually been delivered this
    // session — otherwise comprehension is still 'unknown' and there's
    // nothing for the quiz to advance from.
    await h.client.utter(devSessionId, 'tell me about the project');
    await new Promise(r => setTimeout(r, 300));

    // Project should now be at 'heard'.
    const before = await readComprehensionMap(FIXTURE_PATH);
    expect(before.get('project')).toBe('heard');

    // Start a quiz on the current focus (project).
    const startIdx = (await h.client.events(devSessionId)).events.length;
    await h.client.command(devSessionId, 'quiz_start');

    // Wait for the first question to appear.
    let q1: any = null;
    for (let i = 0; i < 50 && !q1; i++) {
      const ev = await h.client.events(devSessionId);
      const newEvents = ev.events.slice(startIdx);
      q1 = newEvents.find(e => e.type === 'quiz:question');
      if (!q1) await new Promise(r => setTimeout(r, 50));
    }
    expect(q1, 'first quiz question fired').toBeTruthy();

    // Answer all questions with the canonical expected answer (the dev API
    // doesn't expose `expected` directly, but the templated questions are
    // deterministic — the answers are derived from the briefing data:
    // Q0 = first sentence of the project briefing opener,
    // Q1 = first child label, Q2 = second child label).
    // Our templates make 'expected' available by querying the same data we
    // can derive client-side: the briefing children + opener.
    const project = (await h.client.briefing(FIXTURE_PATH, 'project')).briefing;
    const childLabels = (project.children as string[]).map((id: string) =>
      id === 'arch/root' ? 'architecture' : id.split('/').slice(1).join('/'),
    );
    const expectedAnswers = [
      project.opener.split(/[.!?]/)[0]!.trim(),
      childLabels[0],
      childLabels[1] ?? childLabels[0],
    ];

    for (let i = 0; i < 3; i++) {
      const ev = await h.client.events(devSessionId);
      const newEvents = ev.events.slice(startIdx);
      const qs = newEvents.filter(e => e.type === 'quiz:question');
      const current = qs[i];
      expect(current, `quiz question ${i} fired`).toBeTruthy();
      await h.client.quizAnswer(devSessionId, current.payload.questionId, expectedAnswers[i]);
      // Brief tick so the next question can fire before we look.
      await new Promise(r => setTimeout(r, 100));
    }

    // Wait for quiz:result to appear.
    let result: any = null;
    for (let i = 0; i < 50 && !result; i++) {
      const ev = await h.client.events(devSessionId);
      result = ev.events.slice(startIdx).find(e => e.type === 'quiz:result');
      if (!result) await new Promise(r => setTimeout(r, 50));
    }
    expect(result, 'quiz:result emitted').toBeTruthy();
    expect(result.payload.correct).toBe(3);
    expect(result.payload.total).toBe(3);
    expect(result.payload.newLevel).toBe('confirmed');

    const after = await readComprehensionMap(FIXTURE_PATH);
    expect(after.get('project')).toBe('confirmed');
  }, 90_000);

  it('F. quiz scoring tiers: 2/3 → explained, ≤1 → stays heard (no demotion)', async () => {
    // Run quiz on `module/utils` so we have a fresh briefing not yet confirmed
    // by the previous test. Drill in via utterance, then quiz.
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'updates',
      sinceDays: 30,
    });
    await settleIntoExplore(devSessionId);
    await h.client.utter(devSessionId, 'tell me about utils');
    await new Promise(r => setTimeout(r, 200));

    const utilsBefore = (await readComprehensionMap(FIXTURE_PATH)).get('module/utils');
    expect(utilsBefore).toBe('heard');

    // Helper: run quiz, answer with `getAnswer(i)`, return final result event.
    const runQuiz = async (getAnswer: (qIndex: number, expected: string) => string): Promise<any> => {
      const startIdx = (await h.client.events(devSessionId)).events.length;
      await h.client.command(devSessionId, 'quiz_start');
      // Reverse-derive each expected from the briefing data + template
      // structure (same logic as test E).
      const briefing = (await h.client.briefing(FIXTURE_PATH, 'module/utils')).briefing;
      const childLabels = (briefing.children as string[]).map((id: string) =>
        id.indexOf('/') === -1 ? id : id.split('/').slice(1).join('/'),
      );
      const expectedByIdx = [
        briefing.opener.split(/[.!?]/)[0]!.trim(),
        childLabels[0] ?? briefing.title,
        childLabels[1] ?? childLabels[0] ?? briefing.title,
      ];

      for (let i = 0; i < 3; i++) {
        let q: any = null;
        for (let attempt = 0; attempt < 50 && !q; attempt++) {
          const ev = await h.client.events(devSessionId);
          q = ev.events.slice(startIdx).filter(e => e.type === 'quiz:question')[i];
          if (!q) await new Promise(r => setTimeout(r, 30));
        }
        await h.client.quizAnswer(devSessionId, q.payload.questionId, getAnswer(i, expectedByIdx[i]));
        await new Promise(r => setTimeout(r, 80));
      }
      let result: any = null;
      for (let i = 0; i < 50 && !result; i++) {
        const ev = await h.client.events(devSessionId);
        result = ev.events.slice(startIdx).find(e => e.type === 'quiz:result');
        if (!result) await new Promise(r => setTimeout(r, 30));
      }
      return result;
    };

    // 2/3 correct: questions 0 and 1 right, question 2 wrong.
    const r1 = await runQuiz((i, expected) => i === 2 ? 'totally wrong nonsense' : expected);
    expect(r1.payload.correct).toBe(2);
    expect(r1.payload.newLevel).toBe('explained');
    expect((await readComprehensionMap(FIXTURE_PATH)).get('module/utils')).toBe('explained');

    // 1/3 correct: should NOT demote from explained — stay at explained.
    // (The repo's observe is monotonic; level only moves forward.)
    const r2 = await runQuiz((i, expected) => i === 0 ? expected : 'no idea');
    expect(r2.payload.correct).toBe(1);
    // newLevel stays at the existing level (explained), not 'heard'.
    expect((await readComprehensionMap(FIXTURE_PATH)).get('module/utils')).toBe('explained');
  }, 90_000);

  it('G. voice-only flow: drill down + UP arrow without any clicks', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'explore',
      sinceDays: 30,
    });
    await settleIntoExplore(devSessionId);

    // Drill down by voice — utterances only.
    await h.client.utter(devSessionId, 'tell me about auth');
    await new Promise(r => setTimeout(r, 150));
    let nav = await h.client.navigator(devSessionId);
    const drilledTop = nav.frames.at(-1)?.briefingId;
    expect(drilledTop, 'navigator pushed module/auth via voice').toBe('module/auth');

    // Go back via voice — natural-language equivalent of the UP arrow.
    await h.client.utter(devSessionId, 'go back');
    await new Promise(r => setTimeout(r, 150));
    nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId, 'navigator popped via "go back"').not.toBe('module/auth');

    // The UP-arrow programmatic command produces the same result.
    await h.client.utter(devSessionId, 'tell me about payments');
    await new Promise(r => setTimeout(r, 150));
    nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId).toBe('module/payments');
    await h.client.command(devSessionId, 'level_up');
    await new Promise(r => setTimeout(r, 150));
    nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId).not.toBe('module/payments');
  }, 90_000);
});

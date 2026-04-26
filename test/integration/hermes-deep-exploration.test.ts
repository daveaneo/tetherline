/**
 * Hermes — DEEP exploration arc.
 *
 * Reads as a screenplay of one curious developer learning a codebase
 * from the top down. Each beat asserts a specific quality property:
 * substance, layer-appropriate scope, real-data accuracy, comprehension
 * truth.
 *
 * What this test catches that nothing else does:
 *  • Briefing substance — when fed substantive summaries, the composer
 *    must surface the concept, the surprise, and the file-that-owns-it
 *    into the user-facing opener. Bland output fails.
 *  • Layer-appropriate scope — a project-level answer that drops into
 *    function names is wrong. A file-level answer that hand-waves at
 *    architecture is wrong.
 *  • Drill / climb truth — every push and pop maps to a real navigator
 *    transition AND a real briefing emit. Sibling branches stay cold.
 *  • Comprehension truth — after a real journey, the comprehension map
 *    reflects only what the user actually engaged with.
 *
 * The mock here is rich on purpose. It returns substantive per-module
 * summaries that mirror what a quality LLM would write — so the pipeline's
 * job is "preserve and route this substance correctly," and we assert
 * exactly that. The cassette-backed real-LLM truth test (Round 2) layers
 * on top of this without rewriting the assertions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { tetherline, type TetherlineHarness } from '../harness/index.js';
import { MockLLMAdapter, type LLMRequest } from '../../packages/backend/src/intelligence/llm/index.js';

const FIXTURE = '/tmp/tetherline-fixture-hermes-deep';

let h: TetherlineHarness;

/** Rich mock: returns substantive content when the warmer asks per-module
 *  summary prompts. Each summary names the concept, the surprise, and the
 *  file that owns it — the three-part substance bar. */
function buildRichMock(): MockLLMAdapter {
  const mock = new MockLLMAdapter();

  mock.onTool('group_commits', { areas: [{ name: 'Capture pipeline upgrade', description: 'Idempotency added.', commitHashes: [], significance: 'major', theme: 'correctness' }] });
  mock.onTool('narration_segments', { overview: 'o', segments: [{ text: 't', visualCue: { type: 'none' } }] });
  mock.onTool('architecture_graph', { nodes: [{ id: 'cap', label: 'cap', type: 'module', zoomLevel: 1 }], edges: [] });
  mock.onTool('flag_concerns', { concerns: [] });
  mock.onTool('rank_impact', { rankings: [{ areaIndex: 0, overallImpact: 80, impactSummary: 's', riskFlags: [] }] });
  mock.onTool('quiet_week_suggestion', { suggestion: '', suggestedAreaNames: [] });
  mock.onTool('project_overview', {
    overview: 'fixture-hermes is a multi-module fixture project used to exercise the radial-map exploration loop end-to-end. The four worlds are core (capture pipeline), utils (dev logging only), auth (JWTs with keyring rotation), and payments (append-only ledger). The non-obvious detail is that auth falls back to a static cookie in dev mode — tests don\'t need a keyring.',
    purpose: 'Multi-module fixture for the deep exploration arc.',
    techStack: ['TypeScript'],
    keyAreas: ['core', 'auth', 'payments', 'utils'],
    conceptualSteps: [{ icon: '🧱', title: 'Modules', description: 'Four top-level modules.' }],
  });
  mock.onTool('classify_intent', { skillName: 'navigate', confidence: 0.8, params: { direction: 'next' } });
  mock.onTool('detect_modules', {
    modules: [
      { name: 'core', pathPrefixes: ['core'], description: 'Capture pipeline with idempotency guard.' },
      { name: 'utils', pathPrefixes: ['utils'], description: 'Dev-only logger.' },
      { name: 'auth', pathPrefixes: ['auth'], description: 'Token issuance and rotation.' },
      { name: 'payments', pathPrefixes: ['payments'], description: 'Append-only ledger.' },
    ],
  });
  mock.onTool('summarize_files', {
    summaries: [{ index: 0, summary: 'short summary', role: 'entry' }],
  });

  // Per-module substantive summaries — pattern-matched on the prompt so
  // each module gets the right content. Mirrors what a quality LLM would
  // produce given the fixture's actual files.
  const moduleSummary = (mod: string, text: string) =>
    mock.on(
      (req: LLMRequest) => !req.tool && req.messages.some(m =>
        typeof m.content === 'string' && m.content.includes(`Module: ${mod}`),
      ),
      { text },
    );

  moduleSummary(
    'core',
    "The core module owns the capture pipeline — every payment goes through capture.ts. " +
    "The non-obvious part: capture is wrapped in an idempotency store so retries with the same key never double-charge. " +
    "Most of the heavy lifting is in core/capture.ts; idempotency.ts is the in-memory backing store.",
  );

  moduleSummary(
    'auth',
    "The auth module issues short-lived JWTs with key rotation. " +
    "The watch-out is that in dev mode it falls back to a static cookie — the rotation path only runs against the real keyring in production. " +
    "auth/jwt.ts owns issueToken and rotateKey; it's the only file you need to know.",
  );

  moduleSummary(
    'payments',
    "Payments holds the double-entry ledger. " +
    "The constraint that surprises people: rows are append-only, never updated in place — corrections are reversal entries. " +
    "All of it lives in payments/ledger.ts.",
  );

  moduleSummary(
    'utils',
    "Utils is just the dev-only logger. " +
    "In production, structured JSON goes through the observability pipeline instead — utils/log.ts is a print helper, not a real logger. " +
    "Don't be fooled by the name.",
  );

  // Generic project synthesis fallback (used when buildProjectSynthesisPrompt fires).
  mock.on(
    (req: LLMRequest) => !req.tool && req.messages.some(m =>
      typeof m.content === 'string' && m.content.includes('Synthesize') || (typeof m.content === 'string' && m.content.includes('senior engineer would want')),
    ),
    {
      text:
        "fixture-hermes is a multi-module fixture project used to exercise the radial-map exploration loop end-to-end. " +
        "Three worlds: core (capture pipeline), auth (JWTs with rotation), and payments (append-only ledger), plus utils as a dev-only logger. " +
        "The gravity right now is in core — the idempotency guard was added in the most recent commit. " +
        "The non-obvious thing is that auth's key rotation only runs in production; dev tests use a static cookie fallback.",
    },
  );

  // Last-resort default — handles Q&A answers we don't pattern-match.
  mock.on((req: LLMRequest) => !req.tool, { text: 'A reply about the codebase.' });

  return mock;
}

async function readComprehension(): Promise<Map<string, string>> {
  const c = await h.client.comprehension(FIXTURE);
  return new Map(c.items.map(it => [it.itemId, it.level]));
}

function lastBriefing(events: any[]): any | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'narration:briefing') return events[i].payload;
  }
  return null;
}

async function settle(devSessionId: string): Promise<void> {
  await h.client.waitForAnyPhase(
    devSessionId,
    ['PROPOSAL', 'OVERVIEW', 'AREA_WALKTHROUGH', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'HEATMAP', 'WRAP_UP'],
    45_000,
  );
  const session = await h.client.getSession(devSessionId);
  if (session.state.phase === 'PROPOSAL') {
    await h.client.command(devSessionId, 'next');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const s = await h.client.getSession(devSessionId);
      if (s.state.phase !== 'PROPOSAL' && s.state.phase !== 'IDLE' && s.state.phase !== 'ANALYZING') return;
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

beforeAll(async () => {
  execSync(path.resolve('test/fixtures/create-hermes-fixture.sh') + ' ' + FIXTURE, { stdio: 'inherit' });
  h = await tetherline.start({ mock: buildRichMock() });
}, 90_000);

afterAll(async () => {
  await h?.stop();
});

describe('Hermes — deep exploration arc', () => {
  it('full vertical drill: project → architecture → module → file, then climb back up', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE,
      entryMode: 'explore',
      sinceDays: 30,
    });
    await settle(devSessionId);

    // ── L0 PROJECT ────────────────────────────────────────────────────
    // The project briefing should ALREADY have been delivered on session
    // start (since briefings warmed during analysis). Inspect what's in
    // the comprehension map.
    const projectBriefing = (await h.client.briefing(FIXTURE, 'project')).briefing;

    // Substance bar: the opener must name multiple modules (this is a
    // multi-module project — saying "various utilities" wouldn't cut it).
    expect(projectBriefing.opener).toMatch(/core/i);
    expect(projectBriefing.opener).toMatch(/auth/i);
    expect(projectBriefing.opener).toMatch(/payments/i);
    // …and surface the watch-out detail (auth dev fallback) — that's the
    // line that makes the briefing feel like a real human guide.
    expect(projectBriefing.opener).toMatch(/static cookie|dev mode|keyring|fallback/i);
    // Children = the satellites the user can drill into.
    expect(projectBriefing.children.length).toBeLessThanOrEqual(6);
    expect(projectBriefing.children).toEqual(expect.arrayContaining([
      'arch/root', 'module/core', 'module/auth', 'module/payments',
    ]));

    // ── L1 ARCHITECTURE ───────────────────────────────────────────────
    let startIdx = (await h.client.events(devSessionId)).events.length;
    await h.client.utter(devSessionId, 'walk me through the architecture');
    await new Promise(r => setTimeout(r, 150));
    let evs = (await h.client.events(devSessionId)).events.slice(startIdx);
    let archBriefing = lastBriefing(evs);
    expect(archBriefing, 'architecture briefing emitted').toBeTruthy();
    expect(archBriefing.layer).toBe('architecture');
    expect(archBriefing.briefingId).toBe('arch/root');

    let nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId).toBe('arch/root');

    // ── L2 MODULE (auth) ──────────────────────────────────────────────
    startIdx = (await h.client.events(devSessionId)).events.length;
    await h.client.utter(devSessionId, 'tell me about auth');
    await new Promise(r => setTimeout(r, 150));
    evs = (await h.client.events(devSessionId)).events.slice(startIdx);
    let authBriefing = lastBriefing(evs);
    expect(authBriefing, 'auth module briefing emitted').toBeTruthy();
    expect(authBriefing.layer).toBe('module');
    expect(authBriefing.briefingId).toBe('module/auth');

    // Substance: the AUTH module's specific concept (JWT / token) should
    // surface — generic "auth handles authentication" wouldn't pass.
    expect(authBriefing.text).toMatch(/JWT|token|rotation/i);
    // …and the surprise (dev cookie fallback) is the kind of line a real
    // walkthrough must include.
    expect(authBriefing.text).toMatch(/static cookie|dev mode|keyring|fallback/i);
    // …and name the file that does the heavy lifting.
    expect(authBriefing.text).toMatch(/jwt\.ts/);

    nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId).toBe('module/auth');

    // Q&A AT THE MODULE LAYER — a follow-up question about THIS module,
    // not generic. The question references the surprise we just heard.
    startIdx = (await h.client.events(devSessionId)).events.length;
    await h.client.utter(devSessionId, 'what does the dev fallback do exactly?');
    await new Promise(r => setTimeout(r, 250));
    // The reply path (narration:greeting OR narration:stream_chunk) fires.
    evs = (await h.client.events(devSessionId)).events.slice(startIdx);
    const replied = evs.some(e =>
      e.type === 'narration:greeting' || e.type === 'narration:stream_chunk',
    );
    expect(replied, 'Hermes responded to the follow-up').toBe(true);

    // ── CLIMB BACK UP ────────────────────────────────────────────────
    startIdx = (await h.client.events(devSessionId)).events.length;
    await h.client.command(devSessionId, 'level_up');
    await new Promise(r => setTimeout(r, 150));
    evs = (await h.client.events(devSessionId)).events.slice(startIdx);
    expect(evs.find(e => e.type === 'navigator:pop'), 'pop fired').toBeTruthy();

    nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId).not.toBe('module/auth');
    expect(nav.frames.at(-1)?.briefingId).toBe('arch/root');

    // Climb one more: arch/root → project (or empty stack).
    await h.client.command(devSessionId, 'level_up');
    await new Promise(r => setTimeout(r, 150));
    nav = await h.client.navigator(devSessionId);
    // After two pops we're either at project or back to base depth.
    expect(nav.frames.at(-1)?.briefingId).not.toBe('arch/root');

    // ── LATERAL: drill into a different module from the top ──────────
    startIdx = (await h.client.events(devSessionId)).events.length;
    await h.client.utter(devSessionId, 'tell me about payments');
    await new Promise(r => setTimeout(r, 150));
    evs = (await h.client.events(devSessionId)).events.slice(startIdx);
    const paymentsBriefing = lastBriefing(evs);
    expect(paymentsBriefing.briefingId).toBe('module/payments');
    // Different module → different specific concept.
    expect(paymentsBriefing.text).toMatch(/ledger|append-only|double-entry/i);

    // ── FINAL COMPREHENSION STATE — truth check ─────────────────────
    // The session arc above explicitly visited: arch/root, module/auth,
    // module/payments. The project briefing wasn't directly drilled into
    // (no "tell me about the project") so it's legitimately absent or
    // cold. The point is: only what was actually engaged with shows up.
    const map = await readComprehension();
    expect(map.get('arch/root')).toBe('heard');
    expect(map.get('module/auth')).toBe('heard');
    expect(map.get('module/payments')).toBe('heard');
    // Sibling modules NOT touched should be absent or cold — never
    // 'explained' / 'confirmed' just because a parent was heard.
    const coreLevel = map.get('module/core');
    if (coreLevel !== undefined) {
      expect(['unknown', 'mentioned', 'heard'].includes(coreLevel), `module/core level ${coreLevel} should be cold`).toBe(true);
    }
    const utilsLevel = map.get('module/utils');
    if (utilsLevel !== undefined) {
      expect(['unknown', 'mentioned', 'heard'].includes(utilsLevel), `module/utils level ${utilsLevel} should be cold`).toBe(true);
    }
  }, 120_000);

  it('layer-scope discipline: project briefing names architectural shape, not internal symbols', () => {
    // Read directly from DB — no session needed.
    return h.client.briefing(FIXTURE, 'project').then(({ briefing }) => {
      // Project layer: should NOT mention specific function/symbol names
      // like `issueToken`, `rotateKey`, `IdempotencyStore`. Project-level
      // narration is conceptual.
      expect(briefing.opener).not.toMatch(/\bissueToken\b/);
      expect(briefing.opener).not.toMatch(/\brotateKey\b/);
      expect(briefing.opener).not.toMatch(/IdempotencyStore/);
    });
  });

  it('layer-scope discipline: module briefing names concrete files, not just module names', async () => {
    // Module layer SHOULD reference at least one specific file — that's
    // the "anchor in real code" property of a useful module summary.
    // Note: DB row uses `opener`; the WS event payload (used elsewhere)
    // remaps it to `text`.
    const auth = (await h.client.briefing(FIXTURE, 'module/auth')).briefing;
    expect(auth.opener).toMatch(/\.ts/);
    const payments = (await h.client.briefing(FIXTURE, 'module/payments')).briefing;
    expect(payments.opener).toMatch(/\.ts/);
  });

  it('drill from project all the way to code: project → arch → module → file → code', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE,
      entryMode: 'explore',
      sinceDays: 30,
    });
    await settle(devSessionId);

    // Drill into auth (module layer).
    await h.client.utter(devSessionId, 'tell me about auth');
    await new Promise(r => setTimeout(r, 150));
    let nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId).toBe('module/auth');

    // Now ask for the code itself. The fixture's auth module has a
    // jwt.ts file with `issueToken` and `rotateKey`. Walking through
    // issueToken should push a code-layer briefing.
    let startIdx = (await h.client.events(devSessionId)).events.length;
    await h.client.utter(devSessionId, 'walk me through issueToken');
    await new Promise(r => setTimeout(r, 250));
    let evs = (await h.client.events(devSessionId)).events.slice(startIdx);
    const codeBriefing = lastBriefing(evs);
    expect(codeBriefing, 'code-layer briefing emitted').toBeTruthy();
    expect(codeBriefing.layer).toBe('code');
    expect(codeBriefing.briefingId).toMatch(/^code\//);
    // The visual cue carries the file path so a code-panel UI can render.
    expect(codeBriefing.text).toMatch(/issueToken/i);

    nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId).toMatch(/^code\//);

    // Climb back up: pop returns to whatever was below the code briefing.
    startIdx = (await h.client.events(devSessionId)).events.length;
    await h.client.command(devSessionId, 'level_up');
    await new Promise(r => setTimeout(r, 150));
    nav = await h.client.navigator(devSessionId);
    expect(nav.frames.at(-1)?.briefingId).not.toMatch(/^code\//);
  }, 90_000);

  it('drill-by-voice and drill-by-click converge on identical navigator state', async () => {
    // Click path: send the same utterance you'd send if a chip was clicked.
    const a = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'explore', sinceDays: 30 });
    await settle(a.devSessionId);
    await h.client.utter(a.devSessionId, 'tell me about auth');
    await new Promise(r => setTimeout(r, 150));
    const navA = await h.client.navigator(a.devSessionId);

    // Voice path: a natural utterance that hits the same navigator op.
    const b = await h.client.startSession({ repoPath: FIXTURE, entryMode: 'explore', sinceDays: 30 });
    await settle(b.devSessionId);
    await h.client.utter(b.devSessionId, 'show me the auth module');
    await new Promise(r => setTimeout(r, 150));
    const navB = await h.client.navigator(b.devSessionId);

    expect(navA.frames.at(-1)?.briefingId).toBe('module/auth');
    expect(navB.frames.at(-1)?.briefingId).toBe('module/auth');
  }, 90_000);
});

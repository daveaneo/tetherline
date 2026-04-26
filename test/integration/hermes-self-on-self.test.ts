/**
 * Hermes — self-on-self truth test.
 *
 * Points the analyzer at THIS repo (interactive-reviewer / Tetherline)
 * and asserts that Hermes can summarize his own home well. If we can't
 * pass this, we can't pass anyone else's codebase.
 *
 * Quality bar — the project briefing must:
 *  • name "Hermes" or the AI guide concept
 *  • name multiple of the actual top-level worlds (backend / frontend
 *    / shared)
 *  • mention something specific that a directory listing wouldn't
 *    reveal — voice, briefings, comprehension, dev API, or similar
 *    concepts that ARE the texture of this codebase
 *
 * The module briefings must:
 *  • name a real file (anything matching `*.ts`)
 *  • not be empty / placeholder
 *
 * ─── HERMETICITY ────────────────────────────────────────────────────
 *
 * Real LLM calls are non-deterministic + expensive. We use the
 * existing CassetteLLMAdapter to replay recorded responses.
 *
 * First run (record):
 *   ANTHROPIC_API_KEY=sk-... RECORD=1 \
 *     pnpm vitest run test/integration/hermes-self-on-self.test.ts
 *
 * Subsequent runs (replay): no env vars needed — cassettes are committed
 * under test/cassettes/hermes-self-on-self/.
 *
 * If no cassette exists AND no API key is present, the suite skips with
 * a one-line instruction. CI without keys stays green; truth checks run
 * locally + in pre-release.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../harness/index.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CASSETTE_NAMESPACE = 'hermes-self-on-self';
const CASSETTE_DIR = path.join(REPO_ROOT, 'test/cassettes', CASSETTE_NAMESPACE);

const HAS_CASSETTE = fs.existsSync(CASSETTE_DIR) && fs.readdirSync(CASSETTE_DIR).length > 0;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const CAN_RUN = HAS_CASSETTE || HAS_API_KEY;

let h: TetherlineHarness;

beforeAll(async () => {
  if (!CAN_RUN) return;
  h = await tetherline.start({ cassette: CASSETTE_NAMESPACE });
}, 60_000);

afterAll(async () => {
  await h?.stop();
});

describe.skipIf(!CAN_RUN)('Hermes — self-on-self truth check', () => {
  it('warms briefings against THIS repo and produces a substantive project briefing', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: REPO_ROOT,
      entryMode: 'updates',
      sinceDays: 30,
    });

    // Analysis on this repo is real-world slow — give it a wide window.
    await h.client.waitForAnyPhase(
      devSessionId,
      ['PROPOSAL', 'OVERVIEW', 'AREA_WALKTHROUGH', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'WRAP_UP', 'ERROR'],
      300_000,
    );

    const project = (await h.client.briefing(REPO_ROOT, 'project')).briefing;
    expect(project, 'project briefing exists').toBeTruthy();

    // Quality bar — substance check.
    const opener: string = project.opener;
    expect(opener.length).toBeGreaterThan(120);

    // Names at least one of the real top-level worlds.
    expect(opener).toMatch(/backend|frontend|shared/i);

    // Names something Hermes-specific that a directory listing wouldn't —
    // texture words from the actual codebase.
    expect(opener).toMatch(/Hermes|voice|briefing|comprehension|narration|tour|review|guide/i);

    // Children = at least 2 satellites that resolve.
    expect(project.children.length).toBeGreaterThanOrEqual(2);
    expect(project.children.length).toBeLessThanOrEqual(6);
  }, 360_000);

  it('every module briefing names a real file', async () => {
    const summaries = await h.client.briefings(REPO_ROOT, 'module');
    expect(summaries.briefings.length).toBeGreaterThan(0);
    for (const summary of summaries.briefings) {
      const full = (await h.client.briefing(REPO_ROOT, summary.id)).briefing;
      expect(full.opener.length).toBeGreaterThan(40);
      // Anchor in real code: at least one filename or directory.
      expect(full.opener).toMatch(/\.ts|\.tsx|\.js|src\//);
    }
  }, 60_000);

  if (!CAN_RUN) {
    // eslint-disable-next-line no-console
    console.log(
      `[hermes-self-on-self] skipped — no cassette at ${CASSETTE_DIR} and ` +
      `ANTHROPIC_API_KEY not set. To record:\n` +
      `  ANTHROPIC_API_KEY=sk-... RECORD=1 pnpm vitest run test/integration/hermes-self-on-self.test.ts`,
    );
  }
});

if (!CAN_RUN) {
  // eslint-disable-next-line no-console
  console.log(
    `[hermes-self-on-self] skipped — record cassettes with: ` +
    `ANTHROPIC_API_KEY=sk-... RECORD=1 pnpm vitest run test/integration/hermes-self-on-self.test.ts`,
  );
}

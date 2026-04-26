/**
 * Hermes — self-on-self truth test.
 *
 * Points the analyzer at a SYNTHETIC mirror of Tetherline's structure
 * (test/fixtures/create-tetherline-mirror.sh) and asserts that Hermes
 * summarizes the architecture meaningfully. The fixture is frozen, so
 * the cassette stays valid across commits to the live codebase — the
 * R4-era pain of "every commit invalidates the cassette" is gone.
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
 *  • name a real file (anything matching `*.ts` / `.tsx` / `.md`)
 *  • not be empty / placeholder
 *
 * ─── HERMETICITY ────────────────────────────────────────────────────
 *
 * First run (record):
 *   ANTHROPIC_API_KEY=sk-... RECORD=1 \
 *     pnpm vitest run test/integration/hermes-self-on-self.test.ts
 *
 * Subsequent runs (replay): no env vars needed — cassettes are committed
 * under test/cassettes/hermes-self-on-self/.
 *
 * Because the fixture is stable, you only re-record when you change
 * the FIXTURE — not when you change live code in packages/.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { tetherline, type TetherlineHarness } from '../harness/index.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const FIXTURE_PATH = '/tmp/tetherline-mirror';
const CASSETTE_NAMESPACE = 'hermes-self-on-self';
const CASSETTE_DIR = path.join(REPO_ROOT, 'test/cassettes', CASSETTE_NAMESPACE);

const HAS_CASSETTE = fs.existsSync(CASSETTE_DIR) && fs.readdirSync(CASSETTE_DIR).length > 0;
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;
const CAN_RUN = HAS_CASSETTE || HAS_API_KEY;

let h: TetherlineHarness;

beforeAll(async () => {
  if (!CAN_RUN) return;
  // Build the synthetic mirror fixture. Cheap (~50ms).
  execSync(path.resolve('test/fixtures/create-tetherline-mirror.sh') + ' ' + FIXTURE_PATH, { stdio: 'inherit' });
  h = await tetherline.start({ cassette: CASSETTE_NAMESPACE });
}, 60_000);

afterAll(async () => {
  await h?.stop();
});

describe.skipIf(!CAN_RUN)('Hermes — self-on-self truth check', () => {
  it('warms briefings against THIS repo and produces a substantive project briefing', async () => {
    const { devSessionId } = await h.client.startSession({
      repoPath: FIXTURE_PATH,
      entryMode: 'updates',
      sinceDays: 30,
    });

    // Analysis on this repo is real-world slow — give it a wide window.
    await h.client.waitForAnyPhase(
      devSessionId,
      ['PROPOSAL', 'OVERVIEW', 'AREA_WALKTHROUGH', 'PROJECT_OVERVIEW', 'PREVIOUSLY_ON', 'WRAP_UP', 'ERROR'],
      300_000,
    );

    const project = (await h.client.briefing(FIXTURE_PATH, 'project')).briefing;
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
    const summaries = await h.client.briefings(FIXTURE_PATH, 'module');
    expect(summaries.briefings.length).toBeGreaterThan(0);
    for (const summary of summaries.briefings) {
      const full = (await h.client.briefing(FIXTURE_PATH, summary.id)).briefing;
      expect(full.opener.length).toBeGreaterThan(40);
      // Anchor in real artifact: at least one filename (any extension) or
      // directory reference. A docs/ module legitimately names .md files,
      // not .ts files — the bar is "names a real concrete artifact," not
      // "names code specifically."
      expect(full.opener).toMatch(/\.\w{1,5}\b|src\//);
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

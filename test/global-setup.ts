import { execSync } from 'node:child_process';
import path from 'node:path';

/**
 * Vitest global setup — builds the shared git fixtures ONCE, fresh,
 * before any parallel worker forks.
 *
 * Why this has to be global, not per-test:
 *  1. Race — many integration files share /tmp/tetherline-fixture-
 *     small-walkthrough and each did `if (!exists) execSync(create)`.
 *     Under `pool:'forks'` two workers hit the rm-rf+recreate window
 *     simultaneously → "Command failed: create-small-walkthrough.sh".
 *  2. Date rot — the create scripts now date commits relative to
 *     "now". Rebuilding every run guarantees commits stay inside the
 *     entryMode:'updates' sinceDays window; a fixture left over from a
 *     previous day would silently fall out of it and 404 on briefings.
 *
 * Building here, sequentially, before workers exist removes both.
 * Per-test `if (!existsSync) execSync(...)` guards then no-op safely.
 */
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const F = (s: string) => path.join(ROOT, 'test/fixtures', s);

const FIXTURES: Array<[script: string, dest: string]> = [
  ['create-small-walkthrough.sh', '/tmp/tetherline-fixture-small-walkthrough'],
  ['create-hermes-fixture.sh', '/tmp/tetherline-fixture-hermes-flow'],
  ['create-hermes-fixture.sh', '/tmp/tetherline-fixture-hermes-deep'],
  ['create-hermes-fixture.sh', '/tmp/tetherline-fixture-drift'],
  ['create-hermes-fixture.sh', '/tmp/tetherline-fixture-depth'],
  ['create-tetherline-mirror.sh', '/tmp/tetherline-mirror'],
];

export async function setup(): Promise<void> {
  for (const [script, dest] of FIXTURES) {
    execSync(`${F(script)} ${dest}`, { stdio: 'pipe' });
  }
}

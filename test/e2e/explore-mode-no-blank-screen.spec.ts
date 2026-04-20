import { test, expect, type Page } from '@playwright/test';

/**
 * End-to-end reproduction of the 2026-04-20 blank-screen bug:
 * user clicks Begin → Explore, Room mounts but renders nothing.
 *
 * Drives the full stack through a real browser:
 *   1. open lobby
 *   2. find a repo row + click it
 *   3. click Begin session
 *   4. pick Explore in the entry-mode dialog
 *   5. assert the Room has visible content (not blank)
 *
 * Runs unconditionally — if servers are unreachable, skips with a LOUD
 * message so "skipped" doesn't masquerade as "passed."
 */

async function hasRepos(page: Page): Promise<boolean> {
  return (await page.locator('.repo-row').count()) > 0;
}

async function backendReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/dev/ping', baseUrl).toString(), { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch { return false; }
}

test.describe('Explore entry mode — no blank screen', () => {
  test('clicking Begin → Explore shows visible session content', async ({ page, baseURL }) => {
    test.setTimeout(90_000);

    // Precondition: backend reachable. If not, FAIL LOUDLY so nobody mistakes
    // "skipped" for "passing." The whole point of this test is to run.
    const backendUp = await backendReachable('http://127.0.0.1:3847');
    if (!backendUp) {
      throw new Error(
        'Backend at http://127.0.0.1:3847 is not reachable. Start it with ' +
        '`pnpm dev` before running E2E tests. This is a precondition failure, ' +
        'not a test pass.',
      );
    }

    await page.goto('/');
    await expect(page.locator('.lobby-hero')).toBeVisible({ timeout: 10_000 });

    if (!(await hasRepos(page))) {
      // Skipping is fine here — the user just has no repos yet; the flow
      // isn't reachable. A note is emitted so it's not silent.
      test.skip(true, 'No repos in the user DB — add one via the Lobby UI first.');
      return;
    }

    await page.locator('.repo-row').first().click();
    await page.getByRole('button', { name: /Begin session/i }).click();

    await expect(page.getByText(/How should we open/i)).toBeVisible();
    await page.getByText(/^Explore$/).first().click();

    // Room must mount
    await expect(page.locator('[data-testid="session-room"]')).toBeVisible({ timeout: 20_000 });

    // Any non-trivial text content — the pass condition is "not a blank
    // screen," so we accept anything visible: greeting, error banner,
    // briefing, narration bar label, content panel kicker.
    await expect(async () => {
      const roomText = await page.locator('[data-testid="session-room"]').textContent();
      expect((roomText ?? '').trim().length).toBeGreaterThan(20);
    }).toPass({ timeout: 20_000 });
  });
});

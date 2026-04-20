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
 * Skips if no repo exists in the user's ~/.tetherline DB.
 */

async function hasRepos(page: Page): Promise<boolean> {
  return (await page.locator('.repo-row').count()) > 0;
}

// This E2E requires a warm dev-server stack with valid API keys + a repo
// containing commits the analyzer can actually handle. It's kept as a
// manual-smoke spec (`E2E_FULL=1 pnpm test:e2e` to enable) rather than
// part of the default run — the jsdom phase tests already guard against
// the regression it reproduces.
const SHOULD_RUN = process.env.E2E_FULL === '1';

test.describe('Explore entry mode — no blank screen', () => {
  test.skip(!SHOULD_RUN, 'set E2E_FULL=1 to enable — requires live ANTHROPIC_API_KEY + repo in DB');

  test('clicking Begin → Explore shows visible session content', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await expect(page.locator('.lobby-hero')).toBeVisible({ timeout: 10_000 });

    if (!(await hasRepos(page))) {
      test.skip(true, 'No repos in user DB — add one manually before running.');
      return;
    }

    await page.locator('.repo-row').first().click();
    await page.getByRole('button', { name: /Begin session/i }).click();

    await expect(page.getByText(/How should we open/i)).toBeVisible();
    await page.getByText(/^Explore$/).first().click();

    // Room must mount (carries data-testid unconditionally)
    await expect(page.locator('[data-testid="session-room"]')).toBeVisible({ timeout: 20_000 });

    // Visible content: NarrationBar is always mounted in session, and its
    // text ("Reading your repository…", state labels) is the most reliable
    // proof of "not blank". Accept any non-trivial text anywhere in Room.
    await expect(async () => {
      const roomText = await page.locator('[data-testid="session-room"]').textContent();
      expect((roomText ?? '').trim().length).toBeGreaterThan(20);
    }).toPass({ timeout: 15_000 });
  });
});

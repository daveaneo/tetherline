import { test, expect } from '@playwright/test';

/**
 * Entering a session uses the dev API to force-start, then asserts that the
 * frontend reflects the expected UI (NarrationBar visible, voice orb rendered).
 */
test.describe('Session entry', () => {
  test('dev API /ping responds through the backend', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3847/api/dev/ping');
    expect(res.ok()).toBeTruthy();
  });

  test('lobby transitions to session room when a session is started', async ({ page, request }) => {
    // This test is a skeleton; fleshing it out requires seeding a repo + mocks
    // via the harness rather than the live dev server. Left documented for
    // contributors to pick up.
    await page.goto('/');
    await expect(page.locator('.lobby-hero')).toBeVisible();
    // TODO: trigger a session start via dev API and assert .narration appears.
  });
});

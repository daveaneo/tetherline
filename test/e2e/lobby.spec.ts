import { test, expect } from '@playwright/test';

test.describe('Lobby', () => {
  test('renders the editorial hero', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.lobby-hero')).toContainText(/changed/i);
    await expect(page.locator('.lobby-kicker')).toContainText(/Tetherline/);
  });

  test('toolbar shows connection status', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.chrome-brand')).toContainText(/Tetherline/);
  });

  test('exposes window picker with 4 options', async ({ page }) => {
    await page.goto('/');
    const pills = page.locator('.window-pill');
    await expect(pills).toHaveCount(4);
  });
});

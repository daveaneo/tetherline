import { defineConfig } from '@playwright/test';

/**
 * Playwright config — E2E tests run against the real Vite + backend dev
 * servers, using the /api/dev/* endpoints for setup/teardown.
 *
 *   pnpm test:e2e
 *
 * Port discovery: the vite dev server prefers 5173 but falls back to 5174+
 * if another project is holding 5173. Set TETHERLINE_FRONTEND_URL to pin
 * a specific port in CI.
 */
const FRONTEND_URL = process.env.TETHERLINE_FRONTEND_URL ?? 'http://127.0.0.1:5174';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: FRONTEND_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  // No webServer: expect the user's `pnpm dev` to already be running.
  // Playwright's auto-spawn was incompatible with the monorepo's port
  // fallback behaviour.
});

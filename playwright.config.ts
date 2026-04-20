import { defineConfig } from '@playwright/test';

/**
 * Playwright config — E2E tests run the Vite dev server and drive the UI
 * through a real Chromium, using the /api/dev/* endpoints for setup/teardown.
 *
 *   pnpm test:e2e
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  fullyParallel: false, // shared backend; keep serial for now
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    // Starts both backend + frontend; the harness's backend will bind to :3847
    // as usual, and the dev API lives there. Tests drive the UI via baseURL.
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5173',
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

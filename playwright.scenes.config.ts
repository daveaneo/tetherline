import { defineConfig } from '@playwright/test';

/**
 * Dedicated config for the deterministic SCENE gate (H4 hardening).
 *
 * Unlike test:e2e (which expects a long-lived `pnpm dev`), this spawns
 * its OWN fresh Vite on a pinned port for every run and tears it down
 * after. `reuseExistingServer: false` is the whole point — a stale,
 * long-lived HMR'd dev server twice produced false baselines (it kept
 * serving pre-fix code). A fresh process per run makes scene baselines
 * trustworthy autonomously, with zero manual server babysitting.
 *
 * Port 5199 + strictPort: fail loudly on a clash rather than drift to
 * 5200 (the port-fallback ambiguity the main config calls out).
 */
const PORT = 5199;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: 'scenes.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm --filter @tetherline/frontend exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

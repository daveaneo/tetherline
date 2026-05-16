/**
 * Scene visual + console gate (H4).
 *
 * For every deterministic scene × 3 viewports:
 *   - assert ZERO console errors / page errors (hard gate)
 *   - pixel-diff vs a committed baseline screenshot (toHaveScreenshot)
 *   - drop a proof PNG into docs/polish-proof/
 *
 * Scenes need no backend (SceneHost seeds stores + injects the diagram
 * payload), so this is fully deterministic and flake-free. First run
 * writes baselines; later runs fail on any unintended visual change.
 *
 * Requires the Vite dev server running (pnpm dev). Override the URL
 * with TETHERLINE_FRONTEND_URL.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// URL comes from playwright.scenes.config.ts baseURL (its webServer
// spawns a fresh Vite on a pinned port — no stale-HMR class). Env
// override kept for ad-hoc runs against an already-running server.
const BASE = process.env.TETHERLINE_FRONTEND_URL ?? '';
const PROOF = 'docs/polish-proof';

// Kept in sync with packages/frontend/src/scenes/registry.ts
const SCENES = [
  'project-map',
  'heatmap',
  'concern-tint',
  'grill-screen',
  'shelf-notes',
  'shelf-tasks',
  'descend',
  'deep-dive',
  'pipeline',
  'blast-radius',
  'guided-mode',
  'breadcrumb',
];

const VIEWPORTS = [
  { tag: 'desktop', width: 1440, height: 900 },
  { tag: 'tablet', width: 768, height: 1024 },
  { tag: 'mobile', width: 390, height: 844 },
];

test.beforeAll(() => mkdirSync(PROOF, { recursive: true }));

for (const scene of SCENES) {
  for (const vp of VIEWPORTS) {
    test(`scene:${scene} @${vp.tag}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${BASE}/?scene=${scene}`, { waitUntil: 'networkidle' });
      // Let entrance/transition motion settle for a stable frame.
      await page.waitForTimeout(900);

      // Proof artifact (always written, even on fail) for human review.
      await page.screenshot({ path: join(PROOF, `${scene}-${vp.tag}.png`) });

      // Hard gate 1: no runtime errors.
      expect(consoleErrors, `console errors in ${scene}@${vp.tag}:\n${consoleErrors.join('\n')}`).toEqual([]);

      // Hard gate 2: pixel-diff vs committed baseline (deterministic
      // scene → stable; any unintended change fails).
      await expect(page).toHaveScreenshot(`${scene}-${vp.tag}.png`, {
        maxDiffPixelRatio: 0.01,
        animations: 'disabled',
        fullPage: false,
      });
    });
  }
}

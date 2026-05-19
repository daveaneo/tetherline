import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

const root = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@tetherline/shared': path.resolve(root, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/frontend/**/*.test.{ts,tsx}',
    ],
    exclude: ['test/voice/**', 'test/e2e/**', 'node_modules/**', 'dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ['./test/global-setup.ts'],
    reporters: ['default'],
    isolate: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    // Per-file environment: frontend tests use jsdom for React DOM rendering,
    // everything else runs in plain node.
    environmentMatchGlobs: [
      ['test/frontend/**', 'jsdom'],
    ],
  },
});

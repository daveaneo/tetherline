import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/voice/**', 'test/e2e/**', 'node_modules/**', 'dist/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
    // Each test file gets its own process so the LLM default-adapter singleton
    // can't leak between suites.
    isolate: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
});

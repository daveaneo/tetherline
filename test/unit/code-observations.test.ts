/**
 * Code observations — surface-level signals (TODO clusters, long files,
 * untested modules) that get emitted as advisory:concerns during cache
 * warming. Cheap regex pass over the file list, no LLM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { observeCode } from '../../packages/backend/src/intelligence/code-observations.js';

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'observations-'));
});
afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const full = path.join(repoPath, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('observeCode', () => {
  it('flags TODO/FIXME clusters (≥3 markers in one file)', () => {
    write('src/messy.ts', `
      // TODO: reorganize this
      function a() {}
      // FIXME: handle error
      function b() {}
      // TODO: add tests
      function c() {}
      // HACK: workaround for SDK bug
      function d() {}
    `);

    const concerns = observeCode({
      repoPath,
      allFiles: ['src/messy.ts'],
      modules: [{ name: 'src', pathPrefix: 'src' }],
    });
    const todoConcern = concerns.find(c => c.title.includes('TODO/FIXME'));
    expect(todoConcern).toBeTruthy();
    expect(todoConcern!.affectedFiles).toContain('src/messy.ts');
    expect(todoConcern!.severity).toBe('warning');
  });

  it('does NOT flag a file with only 1-2 TODO markers', () => {
    write('src/clean.ts', `// TODO: minor cleanup\nfunction a() {}`);
    const concerns = observeCode({
      repoPath,
      allFiles: ['src/clean.ts'],
      modules: [{ name: 'src', pathPrefix: 'src' }],
    });
    expect(concerns.find(c => c.title.includes('TODO'))).toBeUndefined();
  });

  it('flags long files (> 500 lines) as info-level concerns', () => {
    const longContent = Array(550).fill('// noop').join('\n');
    write('src/long.ts', longContent);

    const concerns = observeCode({
      repoPath,
      allFiles: ['src/long.ts'],
      modules: [{ name: 'src', pathPrefix: 'src' }],
    });
    const longConcern = concerns.find(c => c.title.includes('long'));
    expect(longConcern).toBeTruthy();
    expect(longConcern!.severity).toBe('info');
  });

  it('flags modules without tests', () => {
    write('auth/jwt.ts', 'export const x = 1;');
    write('auth/store.ts', 'export const y = 2;');
    write('auth/util.ts', 'export const z = 3;');

    const concerns = observeCode({
      repoPath,
      allFiles: ['auth/jwt.ts', 'auth/store.ts', 'auth/util.ts'],
      modules: [{ name: 'auth', pathPrefix: 'auth' }],
    });
    const untested = concerns.find(c => c.title.includes('no detectable tests'));
    expect(untested).toBeTruthy();
    expect(untested!.affectedFiles.length).toBeGreaterThan(0);
  });

  it('does NOT flag a module that has tests', () => {
    write('auth/jwt.ts', 'export const x = 1;');
    write('auth/store.ts', 'export const y = 2;');
    write('auth/util.ts', 'export const z = 3;');
    write('auth/jwt.test.ts', 'test("x", () => {});');

    const concerns = observeCode({
      repoPath,
      allFiles: ['auth/jwt.ts', 'auth/store.ts', 'auth/util.ts', 'auth/jwt.test.ts'],
      modules: [{ name: 'auth', pathPrefix: 'auth' }],
    });
    expect(concerns.find(c => c.title.includes('no detectable tests'))).toBeUndefined();
  });

  it('respects the max cap to avoid drowning the user', () => {
    const files: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = `src/f${i}.ts`;
      // Each file has TODOs to ensure each generates a concern.
      write(p, '// TODO: 1\n// TODO: 2\n// TODO: 3\n');
      files.push(p);
    }
    const concerns = observeCode({
      repoPath,
      allFiles: files,
      modules: [{ name: 'src', pathPrefix: 'src' }],
      max: 5,
    });
    expect(concerns.length).toBeLessThanOrEqual(5);
  });
});

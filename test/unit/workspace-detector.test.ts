/**
 * Workspace detector — finds pnpm/npm/yarn/lerna workspace packages so
 * the cache warmer can split a monorepo into its actual member modules.
 *
 * Tests against tmp dirs so we exercise the actual filesystem layout
 * detection logic, not just stub data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectWorkspaces } from '../../packages/backend/src/cache/workspace-detector.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-detector-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writePkg(rel: string, name?: string) {
  const dir = path.join(tmp, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: name ?? path.basename(rel) }));
}

describe('detectWorkspaces', () => {
  it('returns empty for a non-workspace repo', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    expect(detectWorkspaces(tmp)).toEqual([]);
  });

  it('reads pnpm-workspace.yaml + glob-expands "packages/*"', () => {
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), `packages:\n  - 'packages/*'\n`);
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name": "monorepo"}');
    writePkg('packages/backend', '@scope/backend');
    writePkg('packages/frontend', '@scope/frontend');
    writePkg('packages/shared', '@scope/shared');

    const ws = detectWorkspaces(tmp);
    const names = ws.map(w => w.name).sort();
    expect(names).toEqual(['backend', 'frontend', 'shared']);
    // Strips @scope/ — display name is the bare package name.
    expect(ws.find(w => w.name === 'backend')!.fullName).toBe('@scope/backend');
    expect(ws.find(w => w.name === 'backend')!.pathPrefix).toBe('packages/backend');
  });

  it('reads package.json `workspaces` array (npm/yarn classic)', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/*', 'libs/*'],
    }));
    writePkg('apps/web');
    writePkg('libs/ui');

    const ws = detectWorkspaces(tmp);
    expect(ws.map(w => w.pathPrefix).sort()).toEqual(['apps/web', 'libs/ui']);
  });

  it('reads package.json `workspaces.packages` (yarn berry)', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      workspaces: { packages: ['workspaces/*'] },
    }));
    writePkg('workspaces/alpha');

    const ws = detectWorkspaces(tmp);
    expect(ws.map(w => w.name)).toEqual(['alpha']);
  });

  it('reads lerna.json `packages`', () => {
    fs.writeFileSync(path.join(tmp, 'lerna.json'), JSON.stringify({
      packages: ['modules/*'],
    }));
    writePkg('modules/widget');

    const ws = detectWorkspaces(tmp);
    expect(ws.map(w => w.name)).toEqual(['widget']);
  });

  it('skips workspace candidates that lack a package.json (not a real package)', () => {
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), `packages:\n  - 'packages/*'\n`);
    writePkg('packages/real');
    fs.mkdirSync(path.join(tmp, 'packages/empty'));
    // No package.json under packages/empty → must be filtered out.

    const ws = detectWorkspaces(tmp);
    expect(ws.map(w => w.name)).toEqual(['real']);
  });

  it('handles direct (non-glob) workspace paths', () => {
    fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), `packages:\n  - tools/build\n  - tools/release\n`);
    writePkg('tools/build');
    writePkg('tools/release');

    const ws = detectWorkspaces(tmp);
    expect(ws.map(w => w.name).sort()).toEqual(['build', 'release']);
  });

  it('dedupes if a path resolves through multiple patterns', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      workspaces: ['packages/*', 'packages/dup'],
    }));
    writePkg('packages/dup');

    const ws = detectWorkspaces(tmp);
    expect(ws).toHaveLength(1);
    expect(ws[0].name).toBe('dup');
  });
});

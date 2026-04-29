/**
 * Diagram extractor — file view is deterministic; logic view falls back
 * to a file-mirror without an LLM. These tests guard both paths and
 * the helpers (one-line description, weight normalization, name extract).
 */
import { describe, it, expect } from 'vitest';
import {
  extractProjectFileView,
  extractModuleFileView,
  extractProjectLogicView,
} from '../../packages/backend/src/intelligence/diagram-extractor.js';
import type { ContextCacheRepository } from '../../packages/backend/src/db/repositories/context-cache-repo.js';

function fakeCacheRepo(state: {
  project?: any;
  modules?: Array<{ modulePath: string; summary: string; impactScore?: number; imports?: string[]; keyFiles?: string[]; confidence?: number }>;
  files?: Array<{ filePath: string; summary?: string; contentHash?: string }>;
}): ContextCacheRepository {
  const modules = (state.modules ?? []).map(m => ({
    repoPath: '/tmp/fixture',
    modulePath: m.modulePath,
    summary: m.summary,
    source: 'llm' as const,
    keyFiles: m.keyFiles ?? [],
    imports: m.imports ?? [],
    confidence: m.confidence ?? 0.9,
    impactScore: m.impactScore ?? 0,
    generatedAt: new Date().toISOString(),
  }));
  const files = (state.files ?? []).map(f => ({
    repoPath: '/tmp/fixture',
    filePath: f.filePath,
    summary: f.summary ?? '',
    contentHash: f.contentHash ?? 'h',
    connectivity: 0,
    role: 'other',
    confidence: 0.5,
  }));
  return {
    getProject: () => state.project ?? null,
    getModulesForRepo: () => modules,
    getModule: (_r: string, p: string) => modules.find(m => m.modulePath === p) ?? null,
    getFilesForRepo: () => files,
    getFile: (_r: string, p: string) => files.find(f => f.filePath === p) ?? null,
    getQA: () => [],
    upsertProject: () => {},
    upsertModule: () => {},
    upsertFile: () => {},
  } as unknown as ContextCacheRepository;
}

const repoPath = '/tmp/fixture';

describe('extractProjectFileView', () => {
  it('produces center-and-satellites with import edges between modules', () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'Tetherline is a code-review tool.', purpose: 'Stay tethered.', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules: [
        { modulePath: 'auth',     summary: 'Token issuance.',        impactScore: 50, imports: ['utils'] },
        { modulePath: 'utils',    summary: 'Helpers.',                impactScore: 10 },
        { modulePath: 'payments', summary: 'Money movement.',         impactScore: 100, imports: ['auth', 'utils'] },
      ],
    });
    const diagram = extractProjectFileView({ repoPath, cacheRepo: repo, adapter: null });

    expect(diagram.view).toBe('file');
    expect(diagram.scope).toBe('project');
    expect(diagram.title).toMatch(/Tetherline|fixture/);
    // Has a 1-line subtitle ≤ 80 chars.
    expect(diagram.subtitle.length).toBeLessThanOrEqual(81); // allow trailing ellipsis
    expect(diagram.subtitle.length).toBeGreaterThan(0);

    // Center + 3 satellites.
    expect(diagram.nodes.length).toBe(4);
    expect(diagram.nodes[0].id).toBe('project');

    // Gravity ordering: payments (100) → auth (50) → utils (10).
    const moduleNodes = diagram.nodes.filter(n => n.id.startsWith('module/'));
    expect(moduleNodes.map(n => n.id)).toEqual(['module/payments', 'module/auth', 'module/utils']);

    // Edges = real imports.
    expect(diagram.edges).toEqual(expect.arrayContaining([
      { from: 'module/auth',     to: 'module/utils', kind: 'imports' },
      { from: 'module/payments', to: 'module/auth',  kind: 'imports' },
      { from: 'module/payments', to: 'module/utils', kind: 'imports' },
    ]));
  });

  it('caps satellites at 6 (Miller rule)', () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'X.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules: Array.from({ length: 12 }, (_, i) => ({
        modulePath: `m${i}`,
        summary: 'Module summary placeholder text.',
        impactScore: i,
      })),
    });
    const diagram = extractProjectFileView({ repoPath, cacheRepo: repo, adapter: null });
    const moduleNodes = diagram.nodes.filter(n => n.id.startsWith('module/'));
    expect(moduleNodes.length).toBeLessThanOrEqual(6);
  });

  it('node weights normalize to 0.4..1.0 so smallest node still has visual presence', () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'X.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules: [
        { modulePath: 'small', summary: 'Tiny.', impactScore: 1 },
        { modulePath: 'big',   summary: 'Huge.', impactScore: 1000 },
      ],
    });
    const diagram = extractProjectFileView({ repoPath, cacheRepo: repo, adapter: null });
    const small = diagram.nodes.find(n => n.id === 'module/small')!;
    const big = diagram.nodes.find(n => n.id === 'module/big')!;
    expect(small.weight).toBeGreaterThanOrEqual(0.4);
    expect(big.weight).toBe(1);
  });
});

describe('extractModuleFileView', () => {
  it('renders the module with its key files as satellites', () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: '.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules: [{
        modulePath: 'auth',
        summary: 'Auth issues short-lived JWTs and rotates the signing key from the keyring.',
        keyFiles: ['auth/jwt.ts', 'auth/keyring.ts'],
      }],
    });
    const diagram = extractModuleFileView({ repoPath, cacheRepo: repo, adapter: null }, 'auth')!;
    expect(diagram.scope).toBe('module/auth');
    expect(diagram.title).toBe('auth');
    expect(diagram.subtitle).toMatch(/JWT|short-lived|keyring/i);
    expect(diagram.nodes.length).toBe(3); // center + 2 files
    const fileNodes = diagram.nodes.filter(n => n.id.startsWith('file/'));
    expect(fileNodes.map(n => n.label)).toEqual(['jwt.ts', 'keyring.ts']);
  });

  it('returns null for an unknown module', () => {
    const repo = fakeCacheRepo({});
    expect(extractModuleFileView({ repoPath, cacheRepo: repo, adapter: null }, 'no-such')).toBeNull();
  });
});

describe('extractProjectLogicView (no adapter — file-view fallback)', () => {
  it('falls back to a file-view-shaped row tagged as logic', async () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'X.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules: [{ modulePath: 'a', summary: 'Module a.', impactScore: 5 }],
    });
    const diagram = await extractProjectLogicView({ repoPath, cacheRepo: repo, adapter: null });
    expect(diagram.view).toBe('logic');
    // Without an adapter we mirror the file view geometry — guarantees
    // SOMETHING renders even on warmers without an API key.
    expect(diagram.nodes.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import { buildAnchorIndex } from '../../packages/backend/src/intelligence/anchor-index.js';
import type { DiagramRow } from '../../packages/backend/src/db/repositories/diagram-cache-repo.js';

function row(scope: string, nodes: Array<{ id: string; label: string; implementsFiles?: string[] }>): DiagramRow {
  return { repoPath: '/r', scope, view: 'file', title: '', subtitle: '', nodes, edges: [], sourceHash: 'h' } as unknown as DiagramRow;
}

const INDEX = buildAnchorIndex({
  diagramRows: [
    row('project', [
      { id: 'project', label: 'DocForge' },
      { id: 'module/core', label: 'core' },
      { id: 'module/auth', label: 'Auth' },
      { id: 'file/core/file_loader.py', label: 'FileLoader', implementsFiles: ['core/file_loader.py'] },
    ]),
  ],
  modules: [{ modulePath: 'core' }, { modulePath: 'payments' }],
  fileTree: [],
  areas: [{ name: 'Auth refactor' }],
});

describe('buildAnchorIndex', () => {
  it('resolves label, leaf, and case-variant aliases to node ids', () => {
    expect(INDEX.resolve('the FileLoader handles ingestion')).toContain('file/core/file_loader.py');
    expect(INDEX.resolve('look at file_loader.py first')).toContain('file/core/file_loader.py');
    expect(INDEX.resolve('the file loader and then auth')).toContain('module/auth');
  });

  it('matches on word boundaries only — no substring bleed', () => {
    expect(INDEX.resolve('authentic discourse')).not.toContain('module/auth');
    expect(INDEX.resolve('the scorecard')).not.toContain('module/core');
  });

  it('rejects stoplist words and short aliases', () => {
    const ids = INDEX.resolve('the data and code for this file');
    expect(ids).toEqual([]);
  });

  it('indexes modules absent from any diagram row', () => {
    expect(INDEX.resolve('payments went down')).toContain('module/payments');
  });

  it('maps area names onto their module node', () => {
    expect(INDEX.resolve('the Auth refactor area')).toContain('module/auth');
  });

  it('resolveName: exact id, alias, then leaf', () => {
    expect(INDEX.resolveName('module/core')).toBe('module/core');
    expect(INDEX.resolveName('FileLoader')).toBe('file/core/file_loader.py');
    expect(INDEX.resolveName('fileloader')).toBe('file/core/file_loader.py');
    expect(INDEX.resolveName('auth')).toBe('module/auth');
    expect(INDEX.resolveName('nonexistent-thing')).toBeNull();
  });

  it('exposes global sets for the dispatcher', () => {
    expect(INDEX.allNodeIds()).toContain('module/auth');
    expect(INDEX.labels()['module/auth']).toBe('Auth');
    expect(INDEX.allAliases().length).toBeGreaterThan(4);
  });
});

import { describe, it, expect } from 'vitest';
import {
  depGraphCacheKey,
  parseDepcruiserModules,
  inducedSubgraph,
} from '../../packages/backend/src/intelligence/dep-graph.js';

describe('dep-graph cache key', () => {
  it('is stable for same HEAD+config, changes when HEAD changes', () => {
    expect(depGraphCacheKey('abc', 'v1')).toBe(depGraphCacheKey('abc', 'v1'));
    expect(depGraphCacheKey('abc', 'v1')).not.toBe(depGraphCacheKey('def', 'v1'));
    expect(depGraphCacheKey('abc', 'v1')).not.toBe(depGraphCacheKey('abc', 'v2'));
  });
});

describe('parse dependency-cruiser output', () => {
  it('builds nodes+edges, drops self-edges, de-dupes, deterministic', () => {
    const g = parseDepcruiserModules({
      modules: [
        { source: 'a.ts', dependencies: [{ resolved: 'b.ts' }, { resolved: 'b.ts' }, { resolved: 'a.ts' }] },
        { source: 'b.ts', dependencies: [{ resolved: 'c.ts' }] },
      ],
    });
    expect(g.nodes.map(n => n.id)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(g.edges).toEqual([
      { source: 'a.ts', target: 'b.ts' }, // de-duped, self-edge a→a dropped
      { source: 'b.ts', target: 'c.ts' },
    ]);
  });
  it('handles empty / null without throwing', () => {
    expect(parseDepcruiserModules(null)).toEqual({ nodes: [], edges: [] });
    expect(parseDepcruiserModules({ modules: [] })).toEqual({ nodes: [], edges: [] });
  });
});

describe('induced subgraph — the no-hallucination guarantee', () => {
  const gt = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ],
  };

  it('keeps only edges that REALLY exist among picked nodes', () => {
    const sub = inducedSubgraph(gt, ['a', 'b']);
    expect(sub.nodes.map(n => n.id)).toEqual(['a', 'b']);
    expect(sub.edges).toEqual([{ source: 'a', target: 'b' }]); // a→b real; b→c excluded (c not picked)
  });

  it('a non-existent picked id cannot introduce a node or edge', () => {
    const sub = inducedSubgraph(gt, ['a', 'ghost']);
    expect(sub.nodes.map(n => n.id)).toEqual(['a']); // 'ghost' dropped — not in ground truth
    expect(sub.edges).toEqual([]); // no fabricated edge
  });

  it('picking all nodes returns the full real graph, nothing more', () => {
    expect(inducedSubgraph(gt, ['a', 'b', 'c']).edges).toEqual(gt.edges);
  });
});

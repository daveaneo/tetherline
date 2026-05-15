import { describe, it, expect } from 'vitest';
import {
  toElkGraph,
  fromElkGraph,
  shouldUseElk,
} from '../../packages/frontend/src/components/room/elk-adapter.js';

describe('ELK size guard', () => {
  it('radial never uses ELK (stays custom)', () => {
    expect(shouldUseElk('radial', 5)).toBe(false);
  });
  it('non-radial uses ELK within the node-count guard', () => {
    expect(shouldUseElk('flow', 10)).toBe(true);
    expect(shouldUseElk('layered', 60)).toBe(true);
  });
  it('falls back (no ELK) past the guard — a huge repo cannot hang layout', () => {
    expect(shouldUseElk('deps', 61)).toBe(false);
    expect(shouldUseElk('flow', 0)).toBe(false);
  });
});

describe('toElkGraph (pure, deterministic)', () => {
  const nodes = [{ id: 'b' }, { id: 'a' }];
  const edges = [{ id: 'e2', source: 'a', target: 'b' }, { id: 'e1', source: 'b', target: 'a' }];

  it('produces ELK input with sorted, stable order', () => {
    const g = toElkGraph(nodes, edges, 'flow');
    expect(g.children.map(c => c.id)).toEqual(['a', 'b']);
    expect(g.edges.map(e => e.id)).toEqual(['e1', 'e2']);
    expect(g.edges[0]).toEqual({ id: 'e1', sources: ['b'], targets: ['a'] });
  });

  it('maps layout to ELK direction', () => {
    expect(toElkGraph(nodes, [], 'layered').layoutOptions['elk.direction']).toBe('DOWN');
    expect(toElkGraph(nodes, [], 'flow').layoutOptions['elk.direction']).toBe('RIGHT');
  });

  it('identical input → identical output (deterministic)', () => {
    expect(toElkGraph(nodes, edges, 'flow')).toEqual(toElkGraph(nodes, edges, 'flow'));
  });
});

describe('fromElkGraph (ELK output → centered points)', () => {
  it('converts top-left+size to center point', () => {
    const m = fromElkGraph({ children: [{ id: 'a', x: 100, y: 200, width: 180, height: 64 }] });
    expect(m.get('a')).toEqual({ x: 190, y: 232 });
  });
  it('handles missing fields and empty graph without throwing', () => {
    expect(fromElkGraph({ children: [{ id: 'x' }] }).get('x')).toEqual({ x: 0, y: 0 });
    expect(fromElkGraph(null).size).toBe(0);
    expect(fromElkGraph(undefined).size).toBe(0);
  });
});

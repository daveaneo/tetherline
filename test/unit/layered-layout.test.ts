/**
 * Layered (left→right) layout for authored pipeline/sequence diagrams.
 * Radial layout scattered pipeline stages with long crossing curves — the
 * "squiggly nonsensical" look the user flagged (2026-06-10). A pipeline must
 * read as clear staged flow: source on the left, sink on the right, columns
 * by topological rank, deterministic positions (pixel-stable scenes).
 */
import { describe, it, expect } from 'vitest';
import { layeredPositions, edgeKey } from '../../packages/frontend/src/components/room/layered-layout.js';

const VB = { width: 1200, height: 760 };
const col = (r: ReturnType<typeof layeredPositions>, id: string) => r.positions.get(id)!.col;

describe('layeredPositions', () => {
  it('ranks a linear chain into ascending columns', () => {
    const r = layeredPositions(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
      VB,
    );
    expect(col(r, 'a')).toBe(0);
    expect(col(r, 'b')).toBe(1);
    expect(col(r, 'c')).toBe(2);
    expect(r.columns).toBe(3);
    // x strictly increases left→right with the column.
    expect(r.positions.get('a')!.x).toBeLessThan(r.positions.get('b')!.x);
    expect(r.positions.get('b')!.x).toBeLessThan(r.positions.get('c')!.x);
  });

  it('is deterministic across calls', () => {
    const args = [
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
      VB,
    ] as const;
    const r1 = layeredPositions(...args);
    const r2 = layeredPositions(...args);
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(r2.positions.get(id)).toEqual(r1.positions.get(id));
    }
  });

  it('fan-in: two sources share column 0, the shared sink lands one column right', () => {
    const r = layeredPositions(
      [{ id: 's1' }, { id: 's2' }, { id: 'sink' }],
      [{ from: 's1', to: 'sink' }, { from: 's2', to: 'sink' }],
      VB,
    );
    expect(col(r, 's1')).toBe(0);
    expect(col(r, 's2')).toBe(0);
    expect(col(r, 'sink')).toBe(1);
    // the two column-0 nodes get distinct rows (no overlap).
    expect(r.positions.get('s1')!.y).not.toBe(r.positions.get('s2')!.y);
  });

  it('breaks a cycle: A→B→C→A yields 3 columns and exactly one back edge', () => {
    const r = layeredPositions(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
      VB,
    );
    expect(r.columns).toBe(3);
    expect(r.backEdges.size).toBe(1);
    expect(r.backEdges.has(edgeKey('c', 'a'))).toBe(true);
  });

  it('a role:sink with no out-edges is pushed to the last column', () => {
    // a→b, a→done(sink). Longest-path puts done in col 1; the sink nudge
    // keeps it there (maxRank). a→b→c makes maxRank 2 so done moves right.
    const r = layeredPositions(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'done', role: 'sink' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'done' }],
      VB,
    );
    expect(col(r, 'done')).toBe(r.columns - 1);
    expect(col(r, 'c')).toBe(r.columns - 1);
  });

  it('distributes a single column of 9 nodes without overlapping rows', () => {
    const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}` }));
    const r = layeredPositions(nodes, [], VB);
    const ys = nodes.map(n => r.positions.get(n.id)!.y);
    expect(new Set(ys).size).toBe(9);
    // all within the viewbox vertical bounds.
    for (const y of ys) { expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(VB.height); }
  });
});

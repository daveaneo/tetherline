import { describe, it, expect } from 'vitest';
import {
  blastRadiusRings,
  isBlastRadiusRequest,
  type ImportEdge,
} from '../../packages/frontend/src/components/room/blast-radius.js';

// Graph: a → b → c ; d → b   (x → y means "x imports y")
const EDGES: ImportEdge[] = [
  { source: 'a', target: 'b' },
  { source: 'b', target: 'c' },
  { source: 'd', target: 'b' },
];

describe('blast-radius ripple', () => {
  it('dependents: who is impacted if b changes (reverse edges), by hop', () => {
    // ring0=b; ring1=importers of b = a,d; ring2=importers of a/d = none
    expect(blastRadiusRings('b', EDGES, 'dependents')).toEqual([['b'], ['a', 'd']]);
  });

  it('dependencies: what b imports, by hop', () => {
    // ring0=b; ring1=c
    expect(blastRadiusRings('b', EDGES, 'dependencies')).toEqual([['b'], ['c']]);
  });

  it('transitive ripple expands ring by ring (a depends on b depends on c)', () => {
    expect(blastRadiusRings('c', EDGES, 'dependents')).toEqual([['c'], ['b'], ['a', 'd']]);
  });

  it('a node appears only in its SHORTEST ring, never twice', () => {
    // diamond: a→b, a→c, b→d, c→d. From d (dependents): d; then b,c; then a.
    const dia: ImportEdge[] = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'd' },
    ];
    const rings = blastRadiusRings('d', dia, 'dependents');
    expect(rings).toEqual([['d'], ['b', 'c'], ['a']]);
    const flat = rings.flat();
    expect(new Set(flat).size).toBe(flat.length); // no dupes
  });

  it('each ring is sorted — deterministic ripple', () => {
    const rings = blastRadiusRings('b', EDGES, 'dependents');
    expect(rings[1]).toEqual([...rings[1]].sort());
  });

  it('isolated node yields just its own ring', () => {
    expect(blastRadiusRings('z', EDGES)).toEqual([['z']]);
  });

  it('detects blast-radius phrasings only', () => {
    expect(isBlastRadiusRequest('what touches auth')).toBe(true);
    expect(isBlastRadiusRequest('deps of core')).toBe(true);
    expect(isBlastRadiusRequest('blast radius of the parser')).toBe(true);
    expect(isBlastRadiusRequest('explain the parser')).toBe(false);
    expect(isBlastRadiusRequest(null)).toBe(false);
  });
});

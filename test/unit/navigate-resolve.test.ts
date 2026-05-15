import { describe, it, expect } from 'vitest';
import {
  resolveNavigation,
  navigateMissNarration,
} from '../../packages/backend/src/skills/navigate-resolve.js';

const AREAS = [
  { id: 'a1', name: 'Authentication', affectedFiles: ['src/auth/login.ts'] },
  { id: 'a2', name: 'Billing', affectedFiles: ['src/billing/invoice.ts'] },
  { id: 'a3', name: 'Core Pipeline', affectedFiles: ['src/core/run.ts'] },
];

describe('navigate resolution (graceful, never invents)', () => {
  it('hits on a name match', () => {
    expect(resolveNavigation('billing', AREAS)).toEqual({
      kind: 'hit',
      areaId: 'a2',
      areaName: 'Billing',
    });
  });

  it('hits on an affected-file match', () => {
    const r = resolveNavigation('login', AREAS);
    expect(r).toEqual({ kind: 'hit', areaId: 'a1', areaName: 'Authentication' });
  });

  it('MISSES with a fuzzy suggestion — never a hit for a non-place', () => {
    const r = resolveNavigation('authn flow', AREAS);
    expect(r.kind).toBe('miss');
    if (r.kind === 'miss') expect(r.suggestion).toBe('Authentication');
  });

  it('misses with no suggestion when nothing is close', () => {
    expect(resolveNavigation('kubernetes', AREAS)).toEqual({ kind: 'miss', suggestion: undefined });
  });

  it('empty target / no areas → miss, never throws, never invents', () => {
    expect(resolveNavigation('', AREAS).kind).toBe('miss');
    expect(resolveNavigation('anything', []).kind).toBe('miss');
  });

  it('miss narration never implies the place exists', () => {
    expect(navigateMissNarration('xyz', 'Billing')).toMatch(/don't see "xyz".*did you mean Billing/);
    expect(navigateMissNarration('xyz')).toMatch(/don't see "xyz"/);
    expect(navigateMissNarration('xyz')).not.toMatch(/here'?s/i);
  });

  it('resolution is deterministic', () => {
    expect(resolveNavigation('core', AREAS)).toEqual(resolveNavigation('core', AREAS));
  });
});

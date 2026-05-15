import { describe, it, expect } from 'vitest';
import {
  inverseTransition,
  motionVariantFor,
  scopeTransition,
} from '../../packages/frontend/src/components/room/transition-motion.js';
import type { VisualTransition } from '../../packages/shared/src/types/visual-dispatch.js';

const ALL: VisualTransition[] = ['IN_PLACE', 'DESCEND', 'ASCEND', 'LATERAL', 'GENERATE'];

describe('transition-motion grammar', () => {
  it('DESCEND and ASCEND are exact inverses of each other', () => {
    expect(inverseTransition('DESCEND')).toBe('ASCEND');
    expect(inverseTransition('ASCEND')).toBe('DESCEND');
  });

  it('inverse is an involution for every transition', () => {
    for (const t of ALL) {
      expect(inverseTransition(inverseTransition(t))).toBe(t);
    }
  });

  it('DESCEND/ASCEND are one animation played opposite directions', () => {
    const d = motionVariantFor('DESCEND', false);
    const a = motionVariantFor('ASCEND', false);
    // Same duration (one animation); scale enters from opposite sides
    // of the settled 1.0 (in vs out).
    expect(d.duration).toBe(a.duration);
    expect(d.initial.scale).toBeLessThan(1);
    expect(a.initial.scale).toBeGreaterThan(1);
    expect(d.animate).toEqual(a.animate); // both settle identically
  });

  it('LATERAL claims no spatial continuity (scale stays 1)', () => {
    const l = motionVariantFor('LATERAL', false);
    expect(l.initial.scale).toBe(1);
    expect(l.animate.scale).toBe(1);
    expect(l.initial.x).not.toBe(0); // it slides — a cut, not a zoom
  });

  it('IN_PLACE has no motion at all', () => {
    const p = motionVariantFor('IN_PLACE', false);
    expect(p.duration).toBe(0);
    expect(p.initial).toEqual(p.animate);
  });

  it('GENERATE staggers children (draws itself in)', () => {
    expect(motionVariantFor('GENERATE', false).staggerChildren).toBeGreaterThan(0);
  });

  it('scopeTransition derives the relationship from the path change', () => {
    expect(scopeTransition('module/core', 'module/core')).toBe('IN_PLACE');
    expect(scopeTransition('project', 'module/core')).toBe('DESCEND');
    expect(scopeTransition('module/core', 'project')).toBe('ASCEND');
    expect(scopeTransition('module/core', 'module/core/file/loader.py')).toBe('DESCEND');
    expect(scopeTransition('module/core/file/loader.py', 'module/core')).toBe('ASCEND');
    expect(scopeTransition('module/core', 'module/colab')).toBe('LATERAL');
    expect(scopeTransition(null, 'module/core')).toBe('DESCEND');
  });

  it('scopeTransition inverse round-trips DESCEND/ASCEND (time-slider)', () => {
    // Going project→core is DESCEND; rewinding (core→project) must be
    // exactly the inverse so the slider lands on the identical layout.
    const fwd = scopeTransition('project', 'module/core');
    const back = scopeTransition('module/core', 'project');
    expect(back).toBe(inverseTransition(fwd));
  });

  it('reduced motion strips motion but preserves the transition kind', () => {
    for (const t of ALL) {
      const spec = motionVariantFor(t, true);
      expect(spec.duration).toBe(0);
      expect(spec.staggerChildren).toBe(0);
      expect(spec.initial).toEqual(spec.animate); // no visible move
      expect(spec.kind).toBe(t); // relationship still legible for the caption
    }
  });
});

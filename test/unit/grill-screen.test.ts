import { describe, it, expect } from 'vitest';
import { grillScreenActive } from '../../packages/frontend/src/components/room/grill-screen.js';

describe('grill screen activation', () => {
  it('activates only for grill_me', () => {
    expect(grillScreenActive({ skillName: 'grill_me' })).toBe(true);
  });

  it('does not activate for any other skill or empty result', () => {
    for (const s of ['explain', 'critique', 'whats_changed', 'navigate', 'compare', 'visualize']) {
      expect(grillScreenActive({ skillName: s })).toBe(false);
    }
    expect(grillScreenActive(null)).toBe(false);
    expect(grillScreenActive(undefined)).toBe(false);
    expect(grillScreenActive({})).toBe(false);
  });
});

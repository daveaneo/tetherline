import { describe, it, expect } from 'vitest';
import { levelColor } from '../../packages/frontend/src/components/room/level-color.js';

describe('levelColor adapter — single frontend colour source', () => {
  it('maps each rung to its --heat step', () => {
    expect(levelColor('mentioned')).toBe('var(--heat-1)');
    expect(levelColor('heard')).toBe('var(--heat-2)');
    expect(levelColor('engaged')).toBe('var(--heat-3)');
    expect(levelColor('explained')).toBe('var(--heat-4)');
    expect(levelColor('confirmed')).toBe('var(--heat-5)');
  });

  it('returns null for unknown/undefined (preserves the no-halo contract)', () => {
    expect(levelColor('unknown')).toBeNull();
    expect(levelColor(undefined)).toBeNull();
    expect(levelColor(null)).toBeNull();
  });
});

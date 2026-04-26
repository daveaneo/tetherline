/**
 * Depth modifiers — phrases that ask Hermes to compress or expand his
 * answers. The detected tier persists for the session so subsequent
 * answers stay calibrated.
 */
import { describe, it, expect } from 'vitest';
import { detectDepth, depthInstruction } from '../../packages/backend/src/intelligence/depth-modifiers.js';

describe('detectDepth', () => {
  it.each([
    'tldr',
    'TL;DR',
    'shorter please',
    'too long',
    'in short, what is this?',
    'briefly, what does it do?',
    'one sentence answer',
    'sum it up',
  ])('detects tldr from "%s"', (text) => {
    expect(detectDepth(text).tier).toBe('tldr');
  });

  it.each([
    'tell me more',
    'go deeper',
    'in detail please',
    'walk me through it',
    'step by step',
    'line by line',
    'expand on that',
    'elaborate',
    'give me details',
    'what exactly happens?',
  ])('detects deep from "%s"', (text) => {
    expect(detectDepth(text).tier).toBe('deep');
  });

  it.each([
    'what is the auth module?',
    'how does this work?',
    'show me the architecture',
  ])('preserves the current tier when no modifier is present: "%s"', (text) => {
    expect(detectDepth(text, 'normal').tier).toBe('normal');
    expect(detectDepth(text, 'tldr').tier).toBe('tldr');
    expect(detectDepth(text, 'deep').tier).toBe('deep');
  });

  it('flags `changed: true` only when the tier actually moves', () => {
    expect(detectDepth('shorter', 'normal').changed).toBe(true);
    expect(detectDepth('shorter', 'tldr').changed).toBe(false);
    expect(detectDepth('more please', 'deep').changed).toBe(false);
  });

  it('deep takes precedence over tldr when both patterns match', () => {
    // Edge case: "give me more in short" — the user's likely intent is
    // actually "more" (asking for expansion of a particular aspect).
    expect(detectDepth('give me more in short bursts', 'normal').tier).toBe('deep');
  });
});

describe('depthInstruction', () => {
  it('produces compact, distinct length cues per tier', () => {
    const tldr = depthInstruction('tldr');
    const normal = depthInstruction('normal');
    const deep = depthInstruction('deep');

    expect(tldr).toMatch(/one sentence/i);
    expect(normal).toMatch(/2.4|two.*four/i);
    expect(deep).toMatch(/5.8|five.*eight|depth/i);

    // No tier instruction should be empty or absurdly long.
    for (const t of [tldr, normal, deep]) {
      expect(t.length).toBeGreaterThan(20);
      expect(t.length).toBeLessThan(300);
    }
  });
});

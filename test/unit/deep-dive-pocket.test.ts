import { describe, it, expect } from 'vitest';
import {
  initialPocket,
  pocketReducer,
  slideLabel,
  isLoading,
  isPresenting,
  MAX_SLIDES,
  type PocketState,
  type PocketEvent,
} from '../../packages/backend/src/skills/deep-dive-pocket.js';

const run = (evs: PocketEvent[], s: PocketState = initialPocket()) =>
  evs.reduce(pocketReducer, s);

describe('deep_dive pocket — handshake gating', () => {
  it('explicit trigger → awaiting-scope (never enters implicitly)', () => {
    expect(pocketReducer(initialPocket(), { t: 'trigger', topic: 'auth' }).phase).toBe(
      'awaiting-scope',
    );
  });

  it('the ONE question must be answered before composing', () => {
    // a stray "composed" before scope is ignored — no silent launch
    const s = run([{ t: 'trigger', topic: 'auth' }, { t: 'composed', slides: 5 }]);
    expect(s.phase).toBe('awaiting-scope');
  });

  it('scope answer → composing (loading); composed → active@1', () => {
    const s = run([
      { t: 'trigger', topic: 'auth' },
      { t: 'scope', focus: 'token refresh' },
      { t: 'composed', slides: 6 },
    ]);
    expect(s.phase).toBe('active');
    expect(isPresenting(s)).toBe(true);
    expect(slideLabel(s)).toBe('1/6');
  });
});

describe('deep_dive pocket — cancel is valid at question AND loading', () => {
  it('cancel at the question aborts cleanly', () => {
    const s = run([{ t: 'trigger', topic: 'x' }, { t: 'cancel' }]);
    expect(s.phase).toBe('cancelled');
  });

  it('cancel DURING compose aborts the in-flight run (no wasted slides)', () => {
    const s = run([
      { t: 'trigger', topic: 'x' },
      { t: 'scope', focus: 'f' },
      { t: 'cancel' }, // mid-loading
    ]);
    expect(s.phase).toBe('cancelled');
    expect(isLoading(s)).toBe(false);
  });

  it('a late "composed" after cancel is ignored (no resurrection)', () => {
    const s = run([
      { t: 'trigger', topic: 'x' },
      { t: 'scope', focus: 'f' },
      { t: 'cancel' },
      { t: 'composed', slides: 8 },
    ]);
    expect(s.phase).toBe('cancelled');
  });
});

describe('deep_dive pocket — ≤10 budget clamp (server-side)', () => {
  it('clamps a runaway outline to MAX_SLIDES', () => {
    const s = run([
      { t: 'trigger', topic: 'x' },
      { t: 'scope', focus: 'f' },
      { t: 'composed', slides: 999 },
    ]);
    expect(s.total).toBe(MAX_SLIDES);
  });
  it('clamps a degenerate outline up to at least 1', () => {
    const s = run([
      { t: 'trigger', topic: 'x' },
      { t: 'scope', focus: 'f' },
      { t: 'composed', slides: 0 },
    ]);
    expect(s.total).toBe(1);
  });
});

describe('deep_dive pocket — cursor + atomic skip', () => {
  const active = run([
    { t: 'trigger', topic: 'x' },
    { t: 'scope', focus: 'f' },
    { t: 'composed', slides: 3 },
  ]);

  it('next/prev move the cursor, clamped', () => {
    let s = pocketReducer(active, { t: 'next' });
    expect(slideLabel(s)).toBe('2/3');
    s = pocketReducer(s, { t: 'prev' });
    s = pocketReducer(s, { t: 'prev' });
    expect(slideLabel(s)).toBe('1/3'); // clamped at 0
  });

  it('advancing past the last slide exits the pocket', () => {
    let s = active;
    for (let i = 0; i < 5; i++) s = pocketReducer(s, { t: 'next' });
    expect(s.phase).toBe('done');
  });

  it('OUTER skip is atomic — pops the whole pocket, never steps a slide', () => {
    const s = pocketReducer(active, { t: 'skip' });
    expect(s.phase).toBe('done');
    expect(s.slide).toBe(0); // never advanced an inner slide
  });

  it('skip is a no-op when not in a pocket', () => {
    expect(pocketReducer(initialPocket(), { t: 'skip' })).toEqual(initialPocket());
  });
});

describe('deep_dive pocket — resumable cursor', () => {
  it('the cursor persists across unrelated reducer calls', () => {
    let s = run([
      { t: 'trigger', topic: 'x' },
      { t: 'scope', focus: 'f' },
      { t: 'composed', slides: 8 },
      { t: 'next' },
      { t: 'next' },
    ]);
    expect(slideLabel(s)).toBe('3/8');
    // a stray prev-of-bounds or no-op event does not lose position
    s = pocketReducer(s, { t: 'scope', focus: 'ignored' });
    expect(slideLabel(s)).toBe('3/8');
  });
});

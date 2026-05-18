import { describe, it, expect } from 'vitest';
import {
  concernNodeIds,
  isConcernActive,
  activeConcernText,
} from '../../packages/frontend/src/components/room/concern-tint.js';

const NODES = [
  { id: 'module/auth', label: 'Auth' },
  { id: 'module/auth-store', label: 'Auth Store' },
  { id: 'file/core/loader.py', label: 'loader.py' },
  { id: 'module/billing', label: 'Billing' },
];

describe('critique concern tint', () => {
  it('tints exactly the nodes the critique narration names', () => {
    const n = 'The Auth Store retry logic worries me; loader.py looks solid though.';
    expect(concernNodeIds(n, NODES).sort()).toEqual(
      ['file/core/loader.py', 'module/auth-store'].sort(),
    );
  });

  it('prefers the longer, more specific label (auth store over auth)', () => {
    const ids = concernNodeIds('the auth store is fragile', NODES);
    expect(ids).toContain('module/auth-store');
    // "auth" alone also substring-present, but the specific node is
    // the one named — both may match; the specific one must be first.
    expect(ids[0]).toBe('module/auth-store');
  });

  it('word-boundary: does not match inside another word', () => {
    // "billing" must not be flagged by the word "billings" only if
    // distinct; here ensure "Auth" is not matched by "authenticate".
    expect(concernNodeIds('we should authenticate earlier', NODES)).not.toContain('module/auth');
  });

  it('returns nothing when the critique names no node', () => {
    expect(concernNodeIds('the overall approach is reasonable', NODES)).toEqual([]);
    expect(concernNodeIds('', NODES)).toEqual([]);
  });

  it('only critique drives the tint', () => {
    expect(isConcernActive({ skillName: 'critique' })).toBe(true);
    expect(isConcernActive({ skillName: 'explain' })).toBe(false);
    expect(isConcernActive(null)).toBe(false);
  });
});

describe('activeConcernText — ranked critique, active-concern-only', () => {
  const ranked = {
    narration: 'concern one detail. Billing looks great though.',
    visualPayload: {
      concerns: [
        { title: 'Auth fragile', severity: 'high', targets: ['Auth Store'], detail: 'concern one detail. Billing looks great though.' },
        { title: 'Loader slow', severity: 'low', targets: ['loader.py'], detail: 'the loader is a bit slow' },
      ],
    },
  };

  it('returns the ACTIVE concern\'s targets, not the whole narration', () => {
    expect(activeConcernText(ranked, 0)).toBe('Auth Store');
    expect(activeConcernText(ranked, 1)).toBe('loader.py');
  });

  it('a node only PRAISED in the narration is never flagged (the fix)', () => {
    // narration names "Billing" positively; targets do not → no tint.
    const ids = concernNodeIds(activeConcernText(ranked, 0), NODES);
    expect(ids).toEqual(['module/auth-store']);
    expect(ids).not.toContain('module/billing');
  });

  it('the tint MOVES when the active concern changes', () => {
    expect(concernNodeIds(activeConcernText(ranked, 0), NODES)).toEqual(['module/auth-store']);
    expect(concernNodeIds(activeConcernText(ranked, 1), NODES)).toEqual(['file/core/loader.py']);
  });

  it('clamps an out-of-range index', () => {
    expect(activeConcernText(ranked, 99)).toBe('loader.py');
    expect(activeConcernText(ranked, -3)).toBe('Auth Store');
  });

  it('no targets on the concern → falls back to THAT concern\'s prose, not the full narration', () => {
    const noTargets = {
      narration: 'whole narration mentioning Billing',
      visualPayload: { concerns: [{ title: 't', severity: 'high', targets: [], detail: 'just the auth store here' }] },
    };
    expect(activeConcernText(noTargets, 0)).toBe('just the auth store here');
  });

  it('no structured concerns → legacy fallback to narration', () => {
    expect(activeConcernText({ narration: 'the auth store is fragile', visualPayload: {} }, 0))
      .toBe('the auth store is fragile');
    expect(activeConcernText(null, 0)).toBe('');
  });
});

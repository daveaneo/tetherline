import { describe, it, expect } from 'vitest';
import {
  concernNodeIds,
  isConcernActive,
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

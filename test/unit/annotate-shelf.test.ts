import { describe, it, expect } from 'vitest';
import {
  annotationToShelfArtifact,
  isRecallLensRequest,
  pinnedNodeIds,
} from '../../packages/frontend/src/components/room/annotate-shelf.js';

const NOW = () => new Date('2026-05-15T10:00:00.000Z');

describe('annotate → Notebook artifact', () => {
  it('maps an annotate result to a notes shelf artifact', () => {
    const a = annotationToShelfArtifact(
      { skillName: 'annotate', visualPayload: { note: 'retry logic is sketchy', file: 'src/auth/retry.ts', areaName: 'Auth' } },
      'n1',
      NOW,
    );
    expect(a).toEqual({
      id: 'n1',
      section: 'notes',
      summary: 'retry logic is sketchy',
      detail: 'src/auth/retry.ts · Auth',
      nodeId: 'src/auth/retry.ts',
      createdAt: '2026-05-15T10:00:00.000Z',
    });
  });

  it('falls back to narration when no explicit note', () => {
    const a = annotationToShelfArtifact(
      { skillName: 'annotate', narration: 'Noted: check this later.' },
      'n2',
      NOW,
    );
    expect(a?.summary).toBe('Noted: check this later.');
  });

  it('returns null for any non-annotate result (callers append only on non-null)', () => {
    expect(annotationToShelfArtifact({ skillName: 'explain' }, 'x', NOW)).toBeNull();
    expect(annotationToShelfArtifact(null, 'x', NOW)).toBeNull();
  });
});

describe('recall lens request', () => {
  it('detects "show me what I flagged" phrasings', () => {
    for (const t of ['show me what I flagged', 'what did I flag', 'my notebook', 'show my notes']) {
      expect(isRecallLensRequest(t)).toBe(true);
    }
  });
  it('ignores unrelated speech', () => {
    expect(isRecallLensRequest('explain the parser')).toBe(false);
    expect(isRecallLensRequest(null)).toBe(false);
  });
});

describe('pinned node ids (leaf-based, never interior path)', () => {
  const NODES = [
    { id: 'module/auth', label: 'Auth' },
    { id: 'file/auth/retry.ts', label: 'retry.ts' },
    { id: 'module/billing', label: 'Billing' },
  ];

  it('pins the node whose leaf/label matches an annotation target', () => {
    const pins = pinnedNodeIds(['src/auth/retry.ts'], NODES);
    expect(pins.has('file/auth/retry.ts')).toBe(true);
    expect(pins.has('module/billing')).toBe(false);
  });

  it('matches by label too', () => {
    expect(pinnedNodeIds(['Billing'], NODES).has('module/billing')).toBe(true);
  });

  it('does not pin on an interior path segment alone', () => {
    // target "auth" as a bare word should match module/auth (leaf
    // "auth"), but NOT file/auth/retry.ts just because "auth" is in
    // its path.
    const pins = pinnedNodeIds(['auth'], NODES);
    expect(pins.has('module/auth')).toBe(true);
    expect(pins.has('file/auth/retry.ts')).toBe(false);
  });

  it('ignores too-short / empty targets', () => {
    expect(pinnedNodeIds(['', 'a'], NODES).size).toBe(0);
  });
});

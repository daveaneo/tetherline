import { describe, it, expect } from 'vitest';
import {
  LocalTracker,
  trackIssueFromResult,
  trackedIssueToShelfArtifact,
} from '../../packages/backend/src/skills/issue-tracker.js';

const NOW = () => new Date('2026-05-15T09:00:00.000Z');

describe('track_issue placeholder (local register, read-only)', () => {
  it('LocalTracker creates a local-state issue, no external write', () => {
    const i = LocalTracker.create({ title: 'Fix retry', body: 'b', labels: ['bug'] }, 'i1', NOW);
    expect(i).toEqual({
      id: 'i1',
      title: 'Fix retry',
      body: 'b',
      labels: ['bug'],
      state: 'local',
      createdAt: '2026-05-15T09:00:00.000Z',
    });
  });

  it('maps a create_issue result through the tracker', () => {
    const i = trackIssueFromResult(
      { skillName: 'create_issue', visualPayload: { issueTitle: 'T', issueBody: 'B', issueLabels: ['x', 1, 'y'] } },
      'i2',
      LocalTracker,
      NOW,
    );
    expect(i?.title).toBe('T');
    expect(i?.labels).toEqual(['x', 'y']); // non-strings filtered
    expect(i?.state).toBe('local');
  });

  it('falls back to a safe title when none provided', () => {
    const i = trackIssueFromResult({ skillName: 'create_issue', visualPayload: {} }, 'i3', LocalTracker, NOW);
    expect(i?.title).toBe('Untitled follow-up');
  });

  it('returns null for any non-issue result (callers append only on non-null)', () => {
    expect(trackIssueFromResult({ skillName: 'explain' }, 'x', LocalTracker, NOW)).toBeNull();
    expect(trackIssueFromResult(null, 'x', LocalTracker, NOW)).toBeNull();
  });

  it('shelf artifact is a read-only issues row with state pill', () => {
    const i = LocalTracker.create({ title: 'T', body: '', labels: ['a', 'b'] }, 'i4', NOW);
    expect(trackedIssueToShelfArtifact(i)).toEqual({
      id: 'i4',
      section: 'issues',
      summary: 'T',
      detail: 'a, b',
      state: 'local',
      createdAt: '2026-05-15T09:00:00.000Z',
    });
  });

  it('the seam is swappable: a fake adapter is used without touching the mapper', () => {
    const Fake = {
      kind: 'fake',
      create: (d: { title: string; body: string; labels: string[] }, id: string) =>
        ({ id, title: d.title.toUpperCase(), body: d.body, labels: d.labels, state: 'local' as const, createdAt: 'x' }),
    };
    const i = trackIssueFromResult(
      { skillName: 'create_issue', visualPayload: { issueTitle: 'low' } },
      'i5',
      Fake,
    );
    expect(i?.title).toBe('LOW'); // adapter applied, mapper untouched
  });
});

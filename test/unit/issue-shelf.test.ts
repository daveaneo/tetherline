import { describe, it, expect } from 'vitest';
import { issueResultToShelfArtifact } from '../../packages/frontend/src/components/room/issue-shelf.js';

const NOW = () => new Date('2026-05-15T09:30:00.000Z');

describe('create_issue → Issues shelf row (frontend, pure)', () => {
  it('maps a create_issue result to a read-only issues row', () => {
    const a = issueResultToShelfArtifact(
      { skillName: 'create_issue', visualPayload: { issueTitle: 'Fix retry', issueLabels: ['bug', 2, 'p1'] } },
      'i1',
      NOW,
    );
    expect(a).toEqual({
      id: 'i1',
      section: 'issues',
      summary: 'Fix retry',
      detail: 'bug, p1',
      state: 'local',
      createdAt: '2026-05-15T09:30:00.000Z',
    });
  });

  it('safe title fallback when none given', () => {
    expect(
      issueResultToShelfArtifact({ skillName: 'create_issue', visualPayload: {} }, 'i2', NOW)?.summary,
    ).toBe('Untitled follow-up');
  });

  it('returns null for non-issue results (callers append only on non-null)', () => {
    expect(issueResultToShelfArtifact({ skillName: 'annotate' }, 'x', NOW)).toBeNull();
    expect(issueResultToShelfArtifact(null, 'x', NOW)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { computeHeatmap } from '../../packages/backend/src/git/heatmap.js';

// Minimal SimpleGit stub: ls-files + a 30-day log with one commit
// touching changed.ts on 2026-05-10.
const CHANGE_DAY = '2026-05-10T12:00:00Z';
function stubGit() {
  return {
    raw: async () => 'changed.ts\nuntouched.ts\n',
    log: async () => ({
      all: [{ date: CHANGE_DAY, diff: { files: [{ file: 'changed.ts' }] } }],
    }),
  } as any;
}
const fam = (filePath: string, lastReviewedAt: string | null) => ({
  filePath, lastReviewedAt, lastReviewedSessionId: null,
  reviewCount: 0, lastKnownHash: null, familiarityScore: 0,
});

describe('computeHeatmap — green = reviewed SINCE last change (close-the-loop)', () => {
  it('reviewed AFTER the change → green (caught up)', async () => {
    const h = await computeHeatmap('/r', stubGit(), [fam('changed.ts', '2026-05-12T00:00:00Z')]);
    expect(h.entries.find(e => e.filePath === 'changed.ts')!.status).toBe('green');
  });

  it('reviewed BEFORE the change → yellow (went stale)', async () => {
    const h = await computeHeatmap('/r', stubGit(), [fam('changed.ts', '2026-05-01T00:00:00Z')]);
    expect(h.entries.find(e => e.filePath === 'changed.ts')!.status).toBe('yellow');
  });

  it('changed, never reviewed → red (the gap)', async () => {
    const h = await computeHeatmap('/r', stubGit(), []);
    expect(h.entries.find(e => e.filePath === 'changed.ts')!.status).toBe('red');
  });

  it('a just-reviewed file is green even though its commits are recent (the old-rule blocker is fixed)', async () => {
    // lastReviewed = now (> CHANGE_DAY); old rule would keep it yellow
    // because changeIntensity > 0 — new rule says caught up → green.
    const h = await computeHeatmap('/r', stubGit(), [fam('changed.ts', new Date().toISOString())]);
    expect(h.entries.find(e => e.filePath === 'changed.ts')!.status).toBe('green');
  });
});

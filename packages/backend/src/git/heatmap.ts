import type { SimpleGit } from 'simple-git';
import type { HeatmapData, HeatmapEntry } from '@tetherline/shared';
import type { FileFamiliarityRow } from '../db/repositories/heatmap-repo.js';

export async function computeHeatmap(
  repoPath: string,
  git: SimpleGit,
  familiarity: FileFamiliarityRow[],
): Promise<HeatmapData> {
  // Get all tracked files
  const rawFiles = await git.raw(['ls-files']);
  const allFiles = rawFiles.split('\n').filter(Boolean);

  // Get recent change data in a single pass: per file, how many commits
  // touched it AND the timestamp of its most-recent change. The latter
  // is what makes "caught up" honest — green must mean "you reviewed it
  // SINCE it last changed", not merely "no commits in the last 30d"
  // (the old rule left a just-reviewed file yellow for weeks until its
  // commits aged out — the close-the-loop blocker).
  const recentLog = await git.log({ '--since': '30 days ago', '--name-only': null as any });
  const fileChangeCount = new Map<string, number>();
  const fileLastChangeMs = new Map<string, number>();
  for (const entry of recentLog.all) {
    const commitMs = Date.parse((entry as any).date ?? '') || 0;
    const files = (entry as any).diff?.files ?? [];
    for (const f of files) {
      fileChangeCount.set(f.file, (fileChangeCount.get(f.file) ?? 0) + 1);
      if (commitMs > (fileLastChangeMs.get(f.file) ?? 0)) {
        fileLastChangeMs.set(f.file, commitMs);
      }
    }
  }

  const familiarityMap = new Map(familiarity.map(f => [f.filePath, f]));

  const entries: HeatmapEntry[] = allFiles.map(filePath => {
    const fam = familiarityMap.get(filePath);
    const changeIntensity = fileChangeCount.get(filePath) ?? 0;
    const reviewedMs = fam?.lastReviewedAt ? Date.parse(fam.lastReviewedAt) || 0 : 0;
    const lastChangeMs = fileLastChangeMs.get(filePath) ?? 0;

    let status: 'green' | 'yellow' | 'red';
    if (reviewedMs > 0 && (changeIntensity === 0 || reviewedMs >= lastChangeMs)) {
      // Reviewed, and reviewed AT OR AFTER its last change → caught up.
      status = 'green';
    } else if (reviewedMs > 0 && changeIntensity > 0) {
      // Reviewed once, but it changed since → going stale.
      status = 'yellow';
    } else {
      // Changed and never reviewed (or never touched at all) → the gap.
      status = 'red';
    }

    return {
      filePath,
      status,
      changeIntensity,
      lastReviewed: fam?.lastReviewedAt ?? undefined,
      linesChanged: changeIntensity * 10, // rough estimate
      familiarityScore: fam?.familiarityScore ?? 0,
    };
  });

  return {
    repoPath,
    entries,
    generatedAt: new Date().toISOString(),
  };
}

import type { SimpleGit } from 'simple-git';
import type { HeatmapData, HeatmapEntry } from '@interactive-reviewer/shared';
import type { FileFamiliarityRow } from '../db/repositories/heatmap-repo.js';

export async function computeHeatmap(
  repoPath: string,
  git: SimpleGit,
  familiarity: FileFamiliarityRow[],
): Promise<HeatmapData> {
  // Get all tracked files
  const rawFiles = await git.raw(['ls-files']);
  const allFiles = rawFiles.split('\n').filter(Boolean);

  // Get recent change data in a single pass
  const recentLog = await git.log({ '--since': '30 days ago', '--name-only': null as any });
  const fileChangeCount = new Map<string, number>();
  for (const entry of recentLog.all) {
    const files = (entry as any).diff?.files ?? [];
    for (const f of files) {
      fileChangeCount.set(f.file, (fileChangeCount.get(f.file) ?? 0) + 1);
    }
  }

  const familiarityMap = new Map(familiarity.map(f => [f.filePath, f]));

  const entries: HeatmapEntry[] = allFiles.map(filePath => {
    const fam = familiarityMap.get(filePath);
    const changeIntensity = fileChangeCount.get(filePath) ?? 0;

    let status: 'green' | 'yellow' | 'red';
    if (fam?.lastReviewedAt && changeIntensity === 0) {
      status = 'green';
    } else if (fam?.lastReviewedAt && changeIntensity > 0) {
      status = 'yellow';
    } else {
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

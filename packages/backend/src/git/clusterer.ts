import type { CommitDiff, Area, FileDiff, DiffHunk } from '@interactive-reviewer/shared';
import { v4 as uuid } from 'uuid';
import path from 'path';

export async function clusterCommits(diffs: CommitDiff[]): Promise<Area[]> {
  // Heuristic: group by top-level directory
  const groups = new Map<string, CommitDiff[]>();

  for (const diff of diffs) {
    const dirs = new Set<string>();
    for (const fd of diff.fileDiffs) {
      const topDir = fd.path.split('/')[0] ?? 'root';
      dirs.add(topDir);
    }
    if (dirs.size === 0) dirs.add('root');

    for (const dir of dirs) {
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(diff);
    }
  }

  const areas: Area[] = [];
  let orderIndex = 0;

  for (const [dir, commits] of groups) {
    const allFiles = new Set<string>();
    const commitHashes: string[] = [];

    for (const diff of commits) {
      commitHashes.push(diff.commit.hash);
      for (const fd of diff.fileDiffs) {
        if (fd.path.startsWith(dir)) {
          allFiles.add(fd.path);
        }
      }
    }

    const totalChanges = commits.reduce((sum: number, d: CommitDiff) => {
      return sum + d.fileDiffs.reduce((s: number, fd: FileDiff) =>
        s + fd.hunks.reduce((hs: number, h: DiffHunk) => hs + h.content.split('\n').length, 0), 0);
    }, 0);

    areas.push({
      id: uuid(),
      sessionId: '', // set by caller
      name: dir,
      description: `Changes in ${dir}/ (${allFiles.size} files, ${commitHashes.length} commits)`,
      orderIndex: orderIndex++,
      commitHashes: [...new Set(commitHashes)],
      affectedFiles: [...allFiles],
      significance: totalChanges > 200 ? 'major' : totalChanges > 50 ? 'minor' : 'maintenance',
    });
  }

  // Sort: major first, then minor, then maintenance
  areas.sort((a, b) => {
    const order: Record<string, number> = { major: 0, minor: 1, maintenance: 2 };
    return (order[a.significance] ?? 2) - (order[b.significance] ?? 2);
  });

  // Reassign order indices after sort
  areas.forEach((a, i) => a.orderIndex = i);

  return areas;
}

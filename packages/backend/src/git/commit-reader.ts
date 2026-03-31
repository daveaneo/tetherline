import type { SimpleGit } from 'simple-git';
import type { CommitInfo, FileChange } from '@interactive-reviewer/shared';

export async function readCommits(git: SimpleGit, since: Date, until: Date, maxCount: number = 200): Promise<CommitInfo[]> {
  const log = await git.log({
    '--since': since.toISOString(),
    '--until': until.toISOString(),
    '--stat': null,
    '--no-merges': null,
    maxCount,
  } as any);

  return log.all.map(entry => ({
    hash: entry.hash,
    shortHash: entry.hash.slice(0, 8),
    author: entry.author_name,
    date: entry.date,
    message: entry.message,
    filesChanged: parseStatLine(entry.diff?.files ?? []),
  }));
}

function parseStatLine(files: any[]): FileChange[] {
  return files.map(f => ({
    path: f.file,
    insertions: f.insertions ?? 0,
    deletions: f.deletions ?? 0,
  }));
}

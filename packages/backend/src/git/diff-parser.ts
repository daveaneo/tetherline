import type { SimpleGit } from 'simple-git';
import type { CommitInfo, CommitDiff, FileDiff, DiffHunk } from '@tetherline/shared';
import { MAX_DIFF_SIZE, MAX_LINES_PER_FILE_DIFF } from '@tetherline/shared';
import path from 'path';

export async function extractDiffs(git: SimpleGit, commits: CommitInfo[]): Promise<CommitDiff[]> {
  const results: CommitDiff[] = [];

  for (const commit of commits) {
    try {
      const rawDiff = await git.diff([`${commit.hash}^`, commit.hash]);
      const fileDiffs = parseUnifiedDiff(rawDiff);

      const totalSize = fileDiffs.reduce((sum: number, fd: FileDiff) => sum + fd.hunks.reduce((s: number, h: DiffHunk) => s + h.content.length, 0), 0);
      const wasTruncated = totalSize > MAX_DIFF_SIZE;

      const truncated = wasTruncated
        ? fileDiffs.map(fd => truncateFileDiff(fd))
        : fileDiffs;

      results.push({ commit, fileDiffs: truncated, wasTruncated });
    } catch {
      // First commit or other error - skip diff
      results.push({ commit, fileDiffs: [], wasTruncated: false });
    }
  }

  return results;
}

function parseUnifiedDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const pathMatch = section.match(/^a\/(.+?) b\/(.+)/);
    if (!pathMatch) continue;

    const filePath = pathMatch[2];
    const language = detectLanguage(filePath);
    const hunks: DiffHunk[] = [];

    const hunkRegex = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/gm;
    let match: RegExpExecArray | null;
    const hunkStarts: { index: number; oldStart: number; oldLines: number; newStart: number; newLines: number }[] = [];

    while ((match = hunkRegex.exec(section)) !== null) {
      hunkStarts.push({
        index: match.index,
        oldStart: parseInt(match[1], 10),
        oldLines: parseInt(match[2] || '1', 10),
        newStart: parseInt(match[3], 10),
        newLines: parseInt(match[4] || '1', 10),
      });
    }

    for (let i = 0; i < hunkStarts.length; i++) {
      const start = hunkStarts[i];
      const end = i + 1 < hunkStarts.length ? hunkStarts[i + 1].index : section.length;
      const content = section.slice(start.index, end);

      hunks.push({
        oldStart: start.oldStart,
        oldLines: start.oldLines,
        newStart: start.newStart,
        newLines: start.newLines,
        content,
      });
    }

    files.push({ path: filePath, hunks, language });
  }

  return files;
}

function truncateFileDiff(fd: FileDiff): FileDiff {
  const truncatedHunks = fd.hunks.map((h: DiffHunk) => {
    const lines = h.content.split('\n');
    if (lines.length <= MAX_LINES_PER_FILE_DIFF) return h;
    return { ...h, content: lines.slice(0, MAX_LINES_PER_FILE_DIFF).join('\n') + '\n... (truncated)' };
  });
  return { ...fd, hunks: truncatedHunks };
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
    '.rb': 'ruby', '.php': 'php', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
    '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin',
    '.css': 'css', '.scss': 'scss', '.html': 'html',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.sql': 'sql', '.sh': 'bash',
    '.toml': 'toml', '.xml': 'xml', '.vue': 'vue', '.svelte': 'svelte',
  };
  return map[ext] ?? 'text';
}

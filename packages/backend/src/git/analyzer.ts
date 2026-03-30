import simpleGit, { type SimpleGit } from 'simple-git';
import type { CommitInfo, CommitDiff, Area, AnalysisProgress } from '@interactive-reviewer/shared';
import { readCommits } from './commit-reader.js';
import { extractDiffs } from './diff-parser.js';
import { clusterCommits } from './clusterer.js';

export class GitAnalyzer {
  private git: SimpleGit;

  constructor(private repoPath: string) {
    this.git = simpleGit(repoPath);
  }

  async analyze(
    since: Date,
    until: Date,
    onProgress: (progress: AnalysisProgress) => void,
  ): Promise<{ commits: CommitDiff[]; areas: Area[] }> {
    onProgress({ phase: 'reading_commits', progress: 0, message: 'Reading commits...' });
    const commits = await readCommits(this.git, since, until);

    onProgress({ phase: 'parsing_diffs', progress: 0.2, message: `Parsing ${commits.length} commits...` });
    const diffs = await extractDiffs(this.git, commits);

    onProgress({ phase: 'clustering', progress: 0.5, message: 'Clustering changes...' });
    const areas = await clusterCommits(diffs);

    onProgress({ phase: 'complete', progress: 1, message: 'Analysis complete' });

    return { commits: diffs, areas };
  }
}

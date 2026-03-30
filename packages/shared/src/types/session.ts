export interface Session {
  id: string;
  repoPath: string;
  repoName: string;
  startedAt: string;
  completedAt?: string;
  sinceDate: string;
  untilDate: string;
  totalCommits: number;
  totalAreas: number;
  stateSnapshot?: string;
  summary?: string;
}

export interface SessionSummary {
  id: string;
  repoName: string;
  startedAt: string;
  totalCommits: number;
  totalAreas: number;
  summary?: string;
}

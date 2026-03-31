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

export interface Repository {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  lastReviewedAt: string | null;
  lastSessionId: string | null;
  totalSessions: number;
  understandingPct: number;
}

export interface RepositoryDetails extends Repository {
  newCommits: number;
  contributors: string[];
}

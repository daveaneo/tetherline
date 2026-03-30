import type BetterSqlite3 from 'better-sqlite3';

export interface FileFamiliarityRow {
  filePath: string;
  lastReviewedAt: string | null;
  lastReviewedSessionId: string | null;
  reviewCount: number;
  lastKnownHash: string | null;
  familiarityScore: number;
}

export class HeatmapRepository {
  constructor(private db: BetterSqlite3.Database) {}

  getForRepo(repoPath: string): FileFamiliarityRow[] {
    const rows = this.db.prepare(
      'SELECT file_path, last_reviewed_at, last_reviewed_session_id, review_count, last_known_hash, familiarity_score FROM file_familiarity WHERE repo_path = ?'
    ).all(repoPath) as any[];
    return rows.map(row => ({
      filePath: row.file_path,
      lastReviewedAt: row.last_reviewed_at,
      lastReviewedSessionId: row.last_reviewed_session_id,
      reviewCount: row.review_count,
      lastKnownHash: row.last_known_hash,
      familiarityScore: row.familiarity_score,
    }));
  }

  markReviewed(repoPath: string, filePath: string, sessionId: string, contentHash: string): void {
    this.db.prepare(`
      INSERT INTO file_familiarity (repo_path, file_path, last_reviewed_at, last_reviewed_session_id, review_count, last_known_hash, familiarity_score)
      VALUES (?, ?, datetime('now'), ?, 1, ?, 1.0)
      ON CONFLICT(repo_path, file_path) DO UPDATE SET
        last_reviewed_at = datetime('now'),
        last_reviewed_session_id = excluded.last_reviewed_session_id,
        review_count = review_count + 1,
        last_known_hash = excluded.last_known_hash,
        familiarity_score = MIN(1.0, familiarity_score + 0.2),
        updated_at = datetime('now')
    `).run(repoPath, filePath, sessionId, contentHash);
  }

  decayScores(repoPath: string, factor: number = 0.9): void {
    this.db.prepare(`
      UPDATE file_familiarity
      SET familiarity_score = familiarity_score * ?, updated_at = datetime('now')
      WHERE repo_path = ?
    `).run(factor, repoPath);
  }
}

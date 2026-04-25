/**
 * Cross-session conversation log. Saves Q&A pairs so a fresh session can
 * recall what was asked last week. Reads are bounded by `limit` — we never
 * load the full history into memory.
 */
import type BetterSqlite3 from 'better-sqlite3';

export interface QATurn {
  repoPath: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export class QAHistoryRepository {
  constructor(private db: BetterSqlite3.Database) {}

  record(turn: Omit<QATurn, 'createdAt'>): void {
    this.db.prepare(
      `INSERT INTO qa_history (repo_path, session_id, role, content) VALUES (?, ?, ?, ?)`,
    ).run(turn.repoPath, turn.sessionId, turn.role, turn.content);
  }

  /** Recent turns for a repo, optionally excluding the active session so a
   *  fresh session can recall what was asked previously without echoing
   *  itself. Returned in chronological order (oldest first). */
  recent(repoPath: string, opts: { excludeSessionId?: string; limit?: number } = {}): QATurn[] {
    const limit = opts.limit ?? 10;
    const exclude = opts.excludeSessionId ?? '';
    const rows = this.db.prepare(
      `SELECT repo_path, session_id, role, content, created_at
       FROM qa_history
       WHERE repo_path = ? AND session_id != ?
       ORDER BY id DESC
       LIMIT ?`,
    ).all(repoPath, exclude, limit) as Array<{
      repo_path: string; session_id: string; role: string; content: string; created_at: string;
    }>;
    return rows.reverse().map(r => ({
      repoPath: r.repo_path,
      sessionId: r.session_id,
      role: r.role as 'user' | 'assistant',
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  /** Distinct user-side questions across prior sessions for the recall UI. */
  recentQuestions(repoPath: string, opts: { excludeSessionId?: string; limit?: number } = {}): string[] {
    const limit = opts.limit ?? 5;
    const exclude = opts.excludeSessionId ?? '';
    const rows = this.db.prepare(
      `SELECT content
       FROM qa_history
       WHERE repo_path = ? AND session_id != ? AND role = 'user'
       GROUP BY content
       ORDER BY MAX(id) DESC
       LIMIT ?`,
    ).all(repoPath, exclude, limit) as Array<{ content: string }>;
    return rows.map(r => r.content);
  }
}

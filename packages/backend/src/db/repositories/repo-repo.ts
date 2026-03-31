import type BetterSqlite3 from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface RepoRecord {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  lastReviewedAt: string | null;
  lastSessionId: string | null;
  totalSessions: number;
  understandingPct: number;
}

export class RepoRepository {
  constructor(private db: BetterSqlite3.Database) {}

  add(repoPath: string, name: string): RepoRecord {
    const id = uuid();
    this.db.prepare(`
      INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)
    `).run(id, repoPath, name);
    return this.getById(id)!;
  }

  getAll(): RepoRecord[] {
    return (this.db.prepare('SELECT * FROM repositories ORDER BY last_reviewed_at DESC NULLS LAST, added_at DESC').all() as any[])
      .map(this.rowToRecord);
  }

  getById(id: string): RepoRecord | undefined {
    const row = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as any;
    return row ? this.rowToRecord(row) : undefined;
  }

  getByPath(path: string): RepoRecord | undefined {
    const row = this.db.prepare('SELECT * FROM repositories WHERE path = ?').get(path) as any;
    return row ? this.rowToRecord(row) : undefined;
  }

  markReviewed(id: string, sessionId: string): void {
    this.db.prepare(`
      UPDATE repositories
      SET last_reviewed_at = datetime('now'), last_session_id = ?, total_sessions = total_sessions + 1
      WHERE id = ?
    `).run(sessionId, id);
  }

  updateUnderstanding(id: string, pct: number): void {
    this.db.prepare('UPDATE repositories SET understanding_pct = ? WHERE id = ?').run(pct, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM repositories WHERE id = ?').run(id);
  }

  private rowToRecord(row: any): RepoRecord {
    return {
      id: row.id,
      path: row.path,
      name: row.name,
      addedAt: row.added_at,
      lastReviewedAt: row.last_reviewed_at,
      lastSessionId: row.last_session_id,
      totalSessions: row.total_sessions,
      understandingPct: row.understanding_pct,
    };
  }
}

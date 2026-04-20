import type BetterSqlite3 from 'better-sqlite3';
import type { Session, SessionSummary } from '@tetherline/shared';

export class SessionRepository {
  constructor(private db: BetterSqlite3.Database) {}

  createSession(session: Omit<Session, 'totalCommits' | 'totalAreas'>): void {
    this.db.prepare(`
      INSERT INTO sessions (id, repo_path, repo_name, started_at, since_date, until_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(session.id, session.repoPath, session.repoName, session.startedAt, session.sinceDate, session.untilDate);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  listSessions(): SessionSummary[] {
    const rows = this.db.prepare(
      'SELECT id, repo_name, started_at, total_commits, total_areas, summary FROM sessions ORDER BY started_at DESC'
    ).all() as any[];
    return rows.map(row => ({
      id: row.id,
      repoName: row.repo_name,
      startedAt: row.started_at,
      totalCommits: row.total_commits,
      totalAreas: row.total_areas,
      summary: row.summary,
    }));
  }

  updateSession(id: string, updates: Partial<Pick<Session, 'completedAt' | 'totalCommits' | 'totalAreas' | 'stateSnapshot' | 'summary'>>): void {
    const sets: string[] = [];
    const values: any[] = [];

    if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(updates.completedAt); }
    if (updates.totalCommits !== undefined) { sets.push('total_commits = ?'); values.push(updates.totalCommits); }
    if (updates.totalAreas !== undefined) { sets.push('total_areas = ?'); values.push(updates.totalAreas); }
    if (updates.stateSnapshot !== undefined) { sets.push('state_snapshot = ?'); values.push(updates.stateSnapshot); }
    if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary); }

    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getLastSessionForRepo(repoPath: string): Session | undefined {
    const row = this.db.prepare(
      'SELECT * FROM sessions WHERE repo_path = ? ORDER BY started_at DESC LIMIT 1'
    ).get(repoPath) as any;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      repoPath: row.repo_path,
      repoName: row.repo_name,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      sinceDate: row.since_date,
      untilDate: row.until_date,
      totalCommits: row.total_commits,
      totalAreas: row.total_areas,
      stateSnapshot: row.state_snapshot,
      summary: row.summary,
    };
  }
}

import type BetterSqlite3 from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { OnboardingProgram, OnboardingProgress, OnboardingDay } from '@tetherline/shared';

export class OnboardingRepository {
  constructor(private db: BetterSqlite3.Database) {}

  createProgram(program: Omit<OnboardingProgram, 'id' | 'createdAt'>): OnboardingProgram {
    const id = uuid();
    this.db.prepare(
      'INSERT INTO onboarding_programs (id, repo_path, name, total_days, days) VALUES (?, ?, ?, ?, ?)'
    ).run(id, program.repoPath, program.name, program.totalDays, JSON.stringify(program.days));
    return this.getProgram(id)!;
  }

  getProgram(id: string): OnboardingProgram | undefined {
    const row = this.db.prepare('SELECT * FROM onboarding_programs WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    return { id: row.id, repoPath: row.repo_path, name: row.name, totalDays: row.total_days, days: JSON.parse(row.days), createdAt: row.created_at };
  }

  getProgramsForRepo(repoPath: string): OnboardingProgram[] {
    const rows = this.db.prepare('SELECT * FROM onboarding_programs WHERE repo_path = ? ORDER BY created_at DESC').all(repoPath) as any[];
    return rows.map(row => ({ id: row.id, repoPath: row.repo_path, name: row.name, totalDays: row.total_days, days: JSON.parse(row.days), createdAt: row.created_at }));
  }

  getProgress(programId: string): OnboardingProgress | undefined {
    const row = this.db.prepare('SELECT * FROM onboarding_progress WHERE program_id = ?').get(programId) as any;
    if (!row) return undefined;
    return { programId: row.program_id, currentDay: row.current_day, completedDays: JSON.parse(row.completed_days), startedAt: row.started_at, lastActiveAt: row.last_active_at };
  }

  startProgress(programId: string): OnboardingProgress {
    const id = uuid();
    this.db.prepare('INSERT INTO onboarding_progress (id, program_id) VALUES (?, ?)').run(id, programId);
    return this.getProgress(programId)!;
  }

  completeDay(programId: string, dayNumber: number): void {
    const progress = this.getProgress(programId);
    if (!progress) return;
    const completed = [...progress.completedDays, dayNumber];
    const nextDay = Math.min(dayNumber + 1, 5);
    this.db.prepare(
      "UPDATE onboarding_progress SET completed_days = ?, current_day = ?, last_active_at = datetime('now') WHERE program_id = ?"
    ).run(JSON.stringify(completed), nextDay, programId);
  }
}

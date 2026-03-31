import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SessionRepository } from './repositories/session-repo.js';
import { HeatmapRepository } from './repositories/heatmap-repo.js';
import { SettingsRepository } from './repositories/settings-repo.js';
import { AreaRepository } from './repositories/area-repo.js';
import { RepoRepository } from './repositories/repo-repo.js';

export class Database {
  private db: BetterSqlite3.Database;
  private sessionRepo: SessionRepository;
  private heatmapRepo: HeatmapRepository;
  private settingsRepo: SettingsRepository;
  private areaRepo: AreaRepository;
  private repoRepo: RepoRepository;

  constructor(dbPath: string) {
    // Ensure directory exists
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();

    this.sessionRepo = new SessionRepository(this.db);
    this.heatmapRepo = new HeatmapRepository(this.db);
    this.settingsRepo = new SettingsRepository(this.db);
    this.areaRepo = new AreaRepository(this.db);
    this.repoRepo = new RepoRepository(this.db);
  }

  private runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        since_date TEXT NOT NULL,
        until_date TEXT NOT NULL,
        total_commits INTEGER DEFAULT 0,
        total_areas INTEGER DEFAULT 0,
        state_snapshot TEXT,
        summary TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS areas (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL,
        description TEXT,
        order_index INTEGER NOT NULL,
        commit_hashes TEXT NOT NULL DEFAULT '[]',
        affected_files TEXT NOT NULL DEFAULT '[]',
        significance TEXT NOT NULL DEFAULT 'minor',
        narrative_text TEXT,
        narration_segments TEXT DEFAULT '[]',
        architecture_nodes TEXT DEFAULT '[]',
        architecture_edges TEXT DEFAULT '[]',
        deep_dive_generated INTEGER DEFAULT 0,
        deep_dive_content TEXT,
        reviewed INTEGER DEFAULT 0,
        reviewed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS file_familiarity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        last_reviewed_at TEXT,
        last_reviewed_session_id TEXT REFERENCES sessions(id),
        review_count INTEGER DEFAULT 0,
        last_known_hash TEXT,
        familiarity_score REAL DEFAULT 0.0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(repo_path, file_path)
      );

      CREATE TABLE IF NOT EXISTS concerns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        area_id TEXT REFERENCES areas(id),
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        affected_files TEXT DEFAULT '[]',
        commit_hashes TEXT DEFAULT '[]',
        code_references TEXT DEFAULT '[]',
        acknowledged INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        area_id TEXT REFERENCES areas(id),
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        code_references TEXT DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_reviewed_at TEXT,
        last_session_id TEXT REFERENCES sessions(id),
        total_sessions INTEGER DEFAULT 0,
        understanding_pct REAL DEFAULT 0.0
      );

      CREATE INDEX IF NOT EXISTS idx_areas_session ON areas(session_id);
      CREATE INDEX IF NOT EXISTS idx_familiarity_repo ON file_familiarity(repo_path);
      CREATE INDEX IF NOT EXISTS idx_concerns_session ON concerns(session_id);
      CREATE INDEX IF NOT EXISTS idx_concerns_severity ON concerns(severity);
      CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);
    `);
  }

  getSessionRepo(): SessionRepository { return this.sessionRepo; }
  getHeatmapRepo(): HeatmapRepository { return this.heatmapRepo; }
  getSettingsRepo(): SettingsRepository { return this.settingsRepo; }
  getAreaRepo(): AreaRepository { return this.areaRepo; }
  getRepoRepo(): RepoRepository { return this.repoRepo; }
  getRawDb(): BetterSqlite3.Database { return this.db; }

  close() {
    this.db.close();
  }
}

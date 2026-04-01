import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SessionRepository } from './repositories/session-repo.js';
import { HeatmapRepository } from './repositories/heatmap-repo.js';
import { SettingsRepository } from './repositories/settings-repo.js';
import { AreaRepository } from './repositories/area-repo.js';
import { RepoRepository } from './repositories/repo-repo.js';
import { UnderstandingRepository } from './repositories/understanding-repo.js';
import { OnboardingRepository } from './repositories/onboarding-repo.js';

export class Database {
  private db: BetterSqlite3.Database;
  private sessionRepo: SessionRepository;
  private heatmapRepo: HeatmapRepository;
  private settingsRepo: SettingsRepository;
  private areaRepo: AreaRepository;
  private repoRepo: RepoRepository;
  private understandingRepo: UnderstandingRepository;
  private onboardingRepo: OnboardingRepository;

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
    this.understandingRepo = new UnderstandingRepository(this.db);
    this.onboardingRepo = new OnboardingRepository(this.db);
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
        theme TEXT,
        impact_score REAL,
        impact_summary TEXT,
        risk_flags TEXT DEFAULT '[]',
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

      CREATE TABLE IF NOT EXISTS understanding (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        layer TEXT NOT NULL CHECK (layer IN ('project', 'architecture', 'component', 'file', 'code')),
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        parent_id TEXT,
        status TEXT NOT NULL DEFAULT 'not_started',
        last_reviewed_at TEXT,
        stale_since TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(repo_path, layer, item_id)
      );

      CREATE INDEX IF NOT EXISTS idx_understanding_repo ON understanding(repo_path);
      CREATE INDEX IF NOT EXISTS idx_understanding_layer ON understanding(repo_path, layer);

      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        file_path TEXT,
        line_start INTEGER,
        line_end INTEGER,
        node_id TEXT,
        layer TEXT,
        content TEXT NOT NULL,
        created_by TEXT DEFAULT 'user',
        session_id TEXT REFERENCES sessions(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_annotations_repo ON annotations(repo_path);

      CREATE TABLE IF NOT EXISTS onboarding_programs (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        name TEXT NOT NULL,
        total_days INTEGER NOT NULL,
        days TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS onboarding_progress (
        id TEXT PRIMARY KEY,
        program_id TEXT NOT NULL REFERENCES onboarding_programs(id),
        current_day INTEGER DEFAULT 1,
        completed_days TEXT DEFAULT '[]',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS digest_history (
        id TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        content TEXT NOT NULL,
        delivery_status TEXT DEFAULT 'pending',
        delivered_at TEXT,
        error TEXT
      );
    `);

    // Migration: add impact/theme columns to areas table for existing databases
    const areaColumns = this.db.pragma('table_info(areas)') as Array<{ name: string }>;
    const areaColumnNames = new Set(areaColumns.map(c => c.name));
    if (!areaColumnNames.has('theme')) {
      this.db.exec(`ALTER TABLE areas ADD COLUMN theme TEXT`);
    }
    if (!areaColumnNames.has('impact_score')) {
      this.db.exec(`ALTER TABLE areas ADD COLUMN impact_score REAL`);
    }
    if (!areaColumnNames.has('impact_summary')) {
      this.db.exec(`ALTER TABLE areas ADD COLUMN impact_summary TEXT`);
    }
    if (!areaColumnNames.has('risk_flags')) {
      this.db.exec(`ALTER TABLE areas ADD COLUMN risk_flags TEXT DEFAULT '[]'`);
    }
  }

  getSessionRepo(): SessionRepository { return this.sessionRepo; }
  getHeatmapRepo(): HeatmapRepository { return this.heatmapRepo; }
  getSettingsRepo(): SettingsRepository { return this.settingsRepo; }
  getAreaRepo(): AreaRepository { return this.areaRepo; }
  getRepoRepo(): RepoRepository { return this.repoRepo; }
  getUnderstandingRepo(): UnderstandingRepository { return this.understandingRepo; }
  getOnboardingRepo(): OnboardingRepository { return this.onboardingRepo; }
  getRawDb(): BetterSqlite3.Database { return this.db; }

  close() {
    this.db.close();
  }
}

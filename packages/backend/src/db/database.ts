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
import { ContextCacheRepository } from './repositories/context-cache-repo.js';
import { BriefingRepository } from './repositories/briefing-repo.js';
import { ComprehensionRepository } from './repositories/comprehension-repo.js';
import { QAHistoryRepository } from './repositories/qa-history-repo.js';
import { DiagramCacheRepository } from './repositories/diagram-cache-repo.js';
import { LlmCallCacheRepository } from './repositories/llm-call-cache-repo.js';

export class Database {
  private db: BetterSqlite3.Database;
  private sessionRepo: SessionRepository;
  private heatmapRepo: HeatmapRepository;
  private settingsRepo: SettingsRepository;
  private areaRepo: AreaRepository;
  private repoRepo: RepoRepository;
  private understandingRepo: UnderstandingRepository;
  private onboardingRepo: OnboardingRepository;
  private contextCacheRepo: ContextCacheRepository;
  private briefingRepo: BriefingRepository;
  private comprehensionRepo: ComprehensionRepository;
  private qaHistoryRepo: QAHistoryRepository;
  private diagramCacheRepo: DiagramCacheRepository;
  private llmCallCacheRepo: LlmCallCacheRepository;

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
    this.contextCacheRepo = new ContextCacheRepository(this.db);
    this.briefingRepo = new BriefingRepository(this.db);
    this.comprehensionRepo = new ComprehensionRepository(this.db);
    this.qaHistoryRepo = new QAHistoryRepository(this.db);
    this.diagramCacheRepo = new DiagramCacheRepository(this.db);
    this.llmCallCacheRepo = new LlmCallCacheRepository(this.db);
  }

  getLlmCallCacheRepo(): LlmCallCacheRepository { return this.llmCallCacheRepo; }

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

      CREATE TABLE IF NOT EXISTS context_cache_project (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL DEFAULT '',
        purpose TEXT DEFAULT '',
        tech_stack TEXT DEFAULT '[]',
        module_map TEXT DEFAULT '{}',
        trigger_hashes TEXT DEFAULT '{}',
        confidence REAL DEFAULT 0,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        model_version TEXT
      );

      CREATE TABLE IF NOT EXISTS context_cache_module (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        module_path TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        source TEXT DEFAULT 'heuristic',
        key_files TEXT DEFAULT '[]',
        dependencies TEXT DEFAULT '[]',
        file_hash_snapshot TEXT DEFAULT '{}',
        confidence REAL DEFAULT 0,
        impact_score REAL DEFAULT 0,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        model_version TEXT,
        UNIQUE(repo_path, module_path)
      );

      CREATE TABLE IF NOT EXISTS context_cache_file (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL DEFAULT '',
        connectivity INTEGER DEFAULT 0,
        role TEXT DEFAULT 'other',
        confidence REAL DEFAULT 0,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        model_version TEXT,
        UNIQUE(repo_path, file_path)
      );

      CREATE TABLE IF NOT EXISTS context_cache_qa (
        id TEXT PRIMARY KEY,
        repo_path TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        context_key TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_ccm_repo ON context_cache_module(repo_path);
      CREATE INDEX IF NOT EXISTS idx_ccf_repo ON context_cache_file(repo_path);
      CREATE INDEX IF NOT EXISTS idx_ccqa_repo ON context_cache_qa(repo_path, context_key);

      -- Briefings: pre-rendered, TTS-safe spoken answers per depth level.
      -- Served at <500ms to make the app feel like a human guide who always
      -- has the right presentation ready.
      CREATE TABLE IF NOT EXISTS briefings (
        id TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        -- 'code' layer briefings are NOT persisted (composed on-demand
        -- from live file content), so they're absent here intentionally.
        layer TEXT NOT NULL CHECK (layer IN ('project', 'architecture', 'module', 'file', 'concept')),
        title TEXT NOT NULL,
        opener TEXT NOT NULL,
        detail TEXT,
        talking_points TEXT NOT NULL DEFAULT '[]',  -- JSON array
        children TEXT NOT NULL DEFAULT '[]',        -- JSON array of briefing ids
        parent TEXT,
        visual_cue TEXT,                             -- JSON {kind, ref}
        estimated_seconds INTEGER NOT NULL DEFAULT 15,
        source_hash TEXT NOT NULL,
        cached_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (repo_path, id)
      );
      CREATE INDEX IF NOT EXISTS idx_briefings_repo ON briefings(repo_path);
      CREATE INDEX IF NOT EXISTS idx_briefings_layer ON briefings(repo_path, layer);
      CREATE INDEX IF NOT EXISTS idx_briefings_parent ON briefings(repo_path, parent);

      -- Comprehension: per-briefing (or per-concept) confidence model, 6
      -- levels. Passively updated as user talks / listens. Independent of
      -- the legacy understanding table which tracks per-area binary coverage.
      CREATE TABLE IF NOT EXISTS comprehension (
        repo_path TEXT NOT NULL,
        item_id TEXT NOT NULL,
        layer TEXT NOT NULL,
        label TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'unknown' CHECK (level IN ('unknown','mentioned','heard','engaged','explained','confirmed')),
        narration_seconds_heard REAL NOT NULL DEFAULT 0,
        questions_asked INTEGER NOT NULL DEFAULT 0,
        grilled INTEGER NOT NULL DEFAULT 0,
        seen INTEGER NOT NULL DEFAULT 0,
        quiz_correct INTEGER NOT NULL DEFAULT 0,
        quiz_total INTEGER NOT NULL DEFAULT 0,
        grill_strong INTEGER NOT NULL DEFAULT 0,
        grill_asked INTEGER NOT NULL DEFAULT 0,
        last_touched_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_session_id TEXT,
        PRIMARY KEY (repo_path, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_comprehension_repo ON comprehension(repo_path);
      CREATE INDEX IF NOT EXISTS idx_comprehension_level ON comprehension(repo_path, level);
      -- v2 weak-spot review loop: each weak/partial quiz/grill question
      -- becomes an actionable "study this", resolvable by the user (or
      -- auto on a later clean grill). Retained after resolve for audit.
      CREATE TABLE IF NOT EXISTS weak_spots (
        repo_path TEXT NOT NULL,
        item_id TEXT NOT NULL,
        question TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('grill','quiz')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        PRIMARY KEY (repo_path, item_id, question)
      );
      CREATE INDEX IF NOT EXISTS idx_weak_spots_open ON weak_spots(repo_path, resolved_at);

      -- Cross-session conversation log. Lets a fresh session recall what was
      -- asked last time so follow-ups stay coherent across days. Capped via
      -- pruning at read time (we only ever fetch the last N).
      CREATE TABLE IF NOT EXISTS qa_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_qa_history_repo ON qa_history(repo_path, created_at);
      CREATE INDEX IF NOT EXISTS idx_qa_history_session ON qa_history(session_id);

      -- Pre-warmed diagram cache. Keyed by (repo, scope, view) — e.g.
      -- ('/path', 'project', 'logic') or ('/path', 'module/auth',
      -- 'file'). nodes_json + edges_json are the rendered payload.
      -- source_hash drives invalidation — recomputes when underlying
      -- cache rows drift (file content changes etc.).
      CREATE TABLE IF NOT EXISTS diagram_cache (
        repo_path TEXT NOT NULL,
        scope TEXT NOT NULL,
        view TEXT NOT NULL CHECK (view IN ('logic', 'file')),
        title TEXT NOT NULL DEFAULT '',
        subtitle TEXT NOT NULL DEFAULT '',
        nodes_json TEXT NOT NULL DEFAULT '[]',
        edges_json TEXT NOT NULL DEFAULT '[]',
        source_hash TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (repo_path, scope, view)
      );
      CREATE INDEX IF NOT EXISTS idx_diagram_cache_repo ON diagram_cache(repo_path);

      -- Generic content-addressable cache for LLM analyzer calls.
      -- Each row is one cached (phase, inputs) → output mapping.
      -- input_hash is a stable hash of the deterministic inputs for the
      -- call (e.g. commit SHAs for clusterCommits, area+commits for
      -- generateNarrative). Hits skip the LLM entirely.
      CREATE TABLE IF NOT EXISTS llm_call_cache (
        repo_path TEXT NOT NULL,
        phase TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        output_json TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (repo_path, phase, input_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_llm_call_cache_repo ON llm_call_cache(repo_path);
    `);

    // Rename migration: rows stored under ~/.interactive-reviewer/ need
    // their path columns rewritten to ~/.tetherline/ after the 2026-04-20
    // project rename moved the data dir. Idempotent — each UPDATE is a
    // no-op if no rows match the legacy prefix.
    const homedir = process.env.HOME ?? '';
    if (homedir) {
      const legacyPrefix = `${homedir}/.interactive-reviewer`;
      const newPrefix = `${homedir}/.tetherline`;
      const rewrite = (table: string, col: string) => {
        try {
          this.db.prepare(
            `UPDATE ${table} SET ${col} = REPLACE(${col}, ?, ?) WHERE ${col} LIKE ? || '%'`,
          ).run(legacyPrefix, newPrefix, legacyPrefix);
        } catch { /* table or column may not exist yet */ }
      };
      rewrite('repositories', 'path');
      rewrite('sessions', 'repo_path');
      rewrite('file_familiarity', 'repo_path');
      rewrite('understanding', 'repo_path');
      rewrite('annotations', 'repo_path');
      rewrite('context_cache_project', 'repo_path');
      rewrite('context_cache_module', 'repo_path');
      rewrite('context_cache_file', 'repo_path');
      rewrite('context_cache_qa', 'repo_path');
      rewrite('briefings', 'repo_path');
      rewrite('comprehension', 'repo_path');
    }

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

    // Migration: add impact_score to context_cache_module — used by the
    // briefing composer to order radial-map satellites by gravity rather
    // than alphabetically.
    const moduleColumns = this.db.pragma('table_info(context_cache_module)') as Array<{ name: string }>;
    const moduleColumnNames = new Set(moduleColumns.map(c => c.name));
    if (!moduleColumnNames.has('impact_score')) {
      this.db.exec(`ALTER TABLE context_cache_module ADD COLUMN impact_score REAL DEFAULT 0`);
    }

    // Migration: add last_delivered_at to briefings so the session
    // manager can suppress / abbreviate the welcome briefing on quick
    // re-entry. The full briefing every session was a 35s monologue
    // the user had to interrupt to ask anything; ≤30 min re-entries
    // now get a one-liner instead.
    const briefingColumns = this.db.pragma('table_info(briefings)') as Array<{ name: string }>;
    const briefingColumnNames = new Set(briefingColumns.map(c => c.name));
    if (!briefingColumnNames.has('last_delivered_at')) {
      this.db.exec(`ALTER TABLE briefings ADD COLUMN last_delivered_at TEXT`);
    }

    // `grilled` (B-comprehension): a separate active-recall QA proof,
    // distinct from passive `level`. Additive — old rows backfill to 0.
    const compColumns = this.db.pragma('table_info(comprehension)') as Array<{ name: string }>;
    const compColumnNames = new Set(compColumns.map(c => c.name));
    if (!compColumnNames.has('grilled')) {
      this.db.exec(`ALTER TABLE comprehension ADD COLUMN grilled INTEGER NOT NULL DEFAULT 0`);
    }
    // v2: persist the quiz/grill ratios so the score survives reload
    // (v1 only kept the grilled boolean). Additive, backfill 0.
    for (const col of ['quiz_correct', 'quiz_total', 'grill_strong', 'grill_asked', 'seen']) {
      if (!compColumnNames.has(col)) {
        this.db.exec(`ALTER TABLE comprehension ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      }
    }
    // v2 weak_spots table (CREATE IF NOT EXISTS above covers fresh DBs;
    // this guards an older DB created before the table existed).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS weak_spots (
        repo_path TEXT NOT NULL,
        item_id TEXT NOT NULL,
        question TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('grill','quiz')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        PRIMARY KEY (repo_path, item_id, question)
      );
      CREATE INDEX IF NOT EXISTS idx_weak_spots_open ON weak_spots(repo_path, resolved_at);
    `);
  }

  getSessionRepo(): SessionRepository { return this.sessionRepo; }
  getHeatmapRepo(): HeatmapRepository { return this.heatmapRepo; }
  getSettingsRepo(): SettingsRepository { return this.settingsRepo; }
  getAreaRepo(): AreaRepository { return this.areaRepo; }
  getRepoRepo(): RepoRepository { return this.repoRepo; }
  getUnderstandingRepo(): UnderstandingRepository { return this.understandingRepo; }
  getOnboardingRepo(): OnboardingRepository { return this.onboardingRepo; }
  getContextCacheRepo(): ContextCacheRepository { return this.contextCacheRepo; }
  getBriefingRepo(): BriefingRepository { return this.briefingRepo; }
  getComprehensionRepo(): ComprehensionRepository { return this.comprehensionRepo; }
  getQAHistoryRepo(): QAHistoryRepository { return this.qaHistoryRepo; }
  getDiagramCacheRepo(): DiagramCacheRepository { return this.diagramCacheRepo; }
  getRawDb(): BetterSqlite3.Database { return this.db; }

  close() {
    this.db.close();
  }
}

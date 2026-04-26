import type BetterSqlite3 from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export interface ProjectCacheRow {
  repoPath: string;
  summary: string;
  purpose: string;
  techStack: string[];
  moduleMap: Record<string, string[]>;
  triggerHashes: Record<string, string>;
  confidence: number;
}

export interface ModuleCacheRow {
  repoPath: string;
  modulePath: string;
  summary: string;
  source: 'readme' | 'llm' | 'heuristic';
  keyFiles: string[];
  imports: string[];
  confidence: number;
  /** Composite "gravity" score combining recent commit churn against this
   *  module's files and the sum of cross-module fan-in (connectivity) of
   *  its files. Higher = more attention-worthy on the radial map. The
   *  composer uses this to pick + order satellites. */
  impactScore: number;
}

export interface FileCacheRow {
  repoPath: string;
  filePath: string;
  summary: string;
  contentHash: string;
  connectivity: number;
  role: string;
  confidence: number;
}

export interface QACacheRow {
  question: string;
  answer: string;
  contextKey: string;
  sessionId: string;
}

export class ContextCacheRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --- Project ---
  getProject(repoPath: string): ProjectCacheRow | null {
    const row = this.db.prepare('SELECT * FROM context_cache_project WHERE repo_path = ?').get(repoPath) as any;
    if (!row) return null;
    return {
      repoPath: row.repo_path, summary: row.summary, purpose: row.purpose ?? '',
      techStack: JSON.parse(row.tech_stack || '[]'), moduleMap: JSON.parse(row.module_map || '{}'),
      triggerHashes: JSON.parse(row.trigger_hashes || '{}'), confidence: row.confidence ?? 0,
    };
  }

  upsertProject(data: ProjectCacheRow): void {
    this.db.prepare(`
      INSERT INTO context_cache_project (id, repo_path, summary, purpose, tech_stack, module_map, trigger_hashes, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_path) DO UPDATE SET
        summary=excluded.summary, purpose=excluded.purpose, tech_stack=excluded.tech_stack,
        module_map=excluded.module_map, trigger_hashes=excluded.trigger_hashes,
        confidence=excluded.confidence, generated_at=datetime('now')
    `).run(uuid(), data.repoPath, data.summary, data.purpose,
      JSON.stringify(data.techStack), JSON.stringify(data.moduleMap),
      JSON.stringify(data.triggerHashes), data.confidence);
  }

  // --- Module ---
  getModule(repoPath: string, modulePath: string): ModuleCacheRow | null {
    const row = this.db.prepare('SELECT * FROM context_cache_module WHERE repo_path = ? AND module_path = ?').get(repoPath, modulePath) as any;
    if (!row) return null;
    return {
      repoPath: row.repo_path, modulePath: row.module_path, summary: row.summary,
      source: row.source, keyFiles: JSON.parse(row.key_files || '[]'),
      imports: JSON.parse(row.dependencies || '[]'), confidence: row.confidence ?? 0,
      impactScore: row.impact_score ?? 0,
    };
  }

  getModulesForRepo(repoPath: string): ModuleCacheRow[] {
    const rows = this.db.prepare('SELECT * FROM context_cache_module WHERE repo_path = ?').all(repoPath) as any[];
    return rows.map(row => ({
      repoPath: row.repo_path, modulePath: row.module_path, summary: row.summary,
      source: row.source, keyFiles: JSON.parse(row.key_files || '[]'),
      imports: JSON.parse(row.dependencies || '[]'), confidence: row.confidence ?? 0,
      impactScore: row.impact_score ?? 0,
    }));
  }

  upsertModule(data: ModuleCacheRow): void {
    this.db.prepare(`
      INSERT INTO context_cache_module (id, repo_path, module_path, summary, source, key_files, dependencies, confidence, impact_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_path, module_path) DO UPDATE SET
        summary=excluded.summary, source=excluded.source, key_files=excluded.key_files,
        dependencies=excluded.dependencies, confidence=excluded.confidence,
        impact_score=excluded.impact_score, generated_at=datetime('now')
    `).run(uuid(), data.repoPath, data.modulePath, data.summary, data.source,
      JSON.stringify(data.keyFiles), JSON.stringify(data.imports), data.confidence,
      data.impactScore ?? 0);
  }

  // --- File ---
  getFile(repoPath: string, filePath: string): FileCacheRow | null {
    const row = this.db.prepare('SELECT * FROM context_cache_file WHERE repo_path = ? AND file_path = ?').get(repoPath, filePath) as any;
    if (!row) return null;
    return {
      repoPath: row.repo_path, filePath: row.file_path, summary: row.summary,
      contentHash: row.content_hash, connectivity: row.connectivity ?? 0,
      role: row.role ?? 'other', confidence: row.confidence ?? 0,
    };
  }

  getFilesForRepo(repoPath: string): FileCacheRow[] {
    const rows = this.db.prepare('SELECT * FROM context_cache_file WHERE repo_path = ?').all(repoPath) as any[];
    return rows.map(row => ({
      repoPath: row.repo_path, filePath: row.file_path, summary: row.summary,
      contentHash: row.content_hash, connectivity: row.connectivity ?? 0,
      role: row.role ?? 'other', confidence: row.confidence ?? 0,
    }));
  }

  upsertFile(data: FileCacheRow): void {
    this.db.prepare(`
      INSERT INTO context_cache_file (id, repo_path, file_path, summary, content_hash, connectivity, role, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_path, file_path) DO UPDATE SET
        summary=excluded.summary, content_hash=excluded.content_hash, connectivity=excluded.connectivity,
        role=excluded.role, confidence=excluded.confidence, generated_at=datetime('now')
    `).run(uuid(), data.repoPath, data.filePath, data.summary, data.contentHash,
      data.connectivity, data.role, data.confidence);
  }

  deleteFile(repoPath: string, filePath: string): void {
    this.db.prepare('DELETE FROM context_cache_file WHERE repo_path = ? AND file_path = ?').run(repoPath, filePath);
  }

  // --- Q&A ---
  getQA(repoPath: string, contextKey: string): QACacheRow[] {
    return (this.db.prepare(
      'SELECT * FROM context_cache_qa WHERE repo_path = ? AND context_key = ? ORDER BY created_at DESC LIMIT 5'
    ).all(repoPath, contextKey) as any[]).map(row => ({
      question: row.question, answer: row.answer, contextKey: row.context_key, sessionId: row.session_id,
    }));
  }

  addQA(repoPath: string, data: QACacheRow): void {
    this.db.prepare(
      'INSERT INTO context_cache_qa (id, repo_path, question, answer, context_key, session_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(uuid(), repoPath, data.question, data.answer, data.contextKey, data.sessionId);
  }

  // --- Bulk operations ---
  decayConfidence(repoPath: string, modulePath: string, factor: number): void {
    this.db.prepare(
      'UPDATE context_cache_module SET confidence = confidence * ? WHERE repo_path = ? AND module_path = ?'
    ).run(factor, repoPath, modulePath);
    this.db.prepare(
      "UPDATE context_cache_file SET confidence = confidence * ? WHERE repo_path = ? AND file_path LIKE ? || '%'"
    ).run(factor, repoPath, modulePath);
  }
}

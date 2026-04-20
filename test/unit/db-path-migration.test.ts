/**
 * Regression guard: the 2026-04-20 project rename migrated ~/.interactive-reviewer
 * → ~/.tetherline on disk, but forgot to rewrite the `path` / `repo_path`
 * columns in the DB. Users hit blank-screen bugs because the frontend → backend
 * session requests used the stored (now invalid) legacy paths.
 *
 * This test verifies the idempotent path-rewrite migration fires correctly
 * across every table on startup.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database as TetherlineDb } from '../../packages/backend/src/db/database.js';

const home = process.env.HOME ?? os.homedir();
const legacyPath = `${home}/.interactive-reviewer/repos/myrepo`;
const newPath = `${home}/.tetherline/repos/myrepo`;

function freshDb(): { db: TetherlineDb; cleanup: () => void } {
  const tmp = path.join(os.tmpdir(), `tetherline-migration-${Date.now()}-${Math.random()}.db`);
  const db = new TetherlineDb(tmp);
  return {
    db,
    cleanup: () => { db.close(); try { fs.unlinkSync(tmp); } catch {} },
  };
}

describe('DB path migration — interactive-reviewer → tetherline', () => {
  it('rewrites repositories.path when the legacy prefix is present', () => {
    const { db, cleanup } = freshDb();
    try {
      // Seed a legacy-path row
      db.getRawDb().prepare('INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)')
        .run('r1', legacyPath, 'myrepo');

      // Reopen DB to trigger the migration on load
      db.close();
    } finally {
      // Don't cleanup yet — we want to re-open the same file
    }

    // Re-instantiate against the same file
    const tmpPath = (db as any).dbPath ?? '';
    void tmpPath;

    // Simpler: run migration by constructing a fresh TetherlineDb on the same file
    // Actually, our seeded row was inserted AFTER migrations ran — so we need
    // to close + reopen to trigger migrations again on the now-seeded row.
    const tmp = path.join(os.tmpdir(), `tetherline-migration-direct-${Date.now()}.db`);
    const d1 = new TetherlineDb(tmp);
    d1.getRawDb().prepare('INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)')
      .run('r1', legacyPath, 'myrepo');
    d1.close();
    const d2 = new TetherlineDb(tmp);
    const row = d2.getRawDb().prepare('SELECT path FROM repositories WHERE id = ?').get('r1') as { path: string };
    expect(row.path).toBe(newPath);
    d2.close();
    try { fs.unlinkSync(tmp); } catch {}
    cleanup();
  });

  it('leaves unaffected rows untouched (idempotent)', () => {
    const tmp = path.join(os.tmpdir(), `tetherline-migration-noop-${Date.now()}.db`);
    const unaffected = '/some/other/path/not-legacy';

    const d1 = new TetherlineDb(tmp);
    d1.getRawDb().prepare('INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)')
      .run('r1', unaffected, 'r');
    d1.close();
    const d2 = new TetherlineDb(tmp);
    const row = d2.getRawDb().prepare('SELECT path FROM repositories WHERE id = ?').get('r1') as { path: string };
    expect(row.path).toBe(unaffected);
    d2.close();
    try { fs.unlinkSync(tmp); } catch {}
  });

  it('rewrites paths across every table that stores repo paths', () => {
    const tmp = path.join(os.tmpdir(), `tetherline-migration-all-${Date.now()}.db`);
    const legacyRepoPath = `${home}/.interactive-reviewer/repos/r`;
    const newRepoPath = `${home}/.tetherline/repos/r`;

    const d1 = new TetherlineDb(tmp);
    const raw = d1.getRawDb();
    raw.prepare('INSERT INTO repositories (id, path, name) VALUES (?, ?, ?)')
      .run('r1', legacyRepoPath, 'r');
    raw.prepare('INSERT INTO sessions (id, repo_path, repo_name, started_at, since_date, until_date) VALUES (?, ?, ?, ?, ?, ?)')
      .run('s1', legacyRepoPath, 'r', '2026-04-20T00:00:00Z', '2026-04-13T00:00:00Z', '2026-04-20T00:00:00Z');
    raw.prepare('INSERT INTO context_cache_project (repo_path, summary, purpose, tech_stack, module_map, trigger_hashes, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(legacyRepoPath, 's', 'p', '[]', '{}', '{}', 0.9);
    raw.prepare('INSERT INTO briefings (id, repo_path, layer, title, opener, source_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run('project', legacyRepoPath, 'project', 'r', 'opener', 'h');
    raw.prepare('INSERT INTO comprehension (repo_path, item_id, layer, label, level) VALUES (?, ?, ?, ?, ?)')
      .run(legacyRepoPath, 'project', 'project', 'r', 'heard');
    d1.close();

    // Reopen — migration now rewrites all seeded rows
    const d2 = new TetherlineDb(tmp);
    const raw2 = d2.getRawDb();
    expect((raw2.prepare('SELECT path FROM repositories WHERE id = ?').get('r1') as any).path).toBe(newRepoPath);
    expect((raw2.prepare('SELECT repo_path FROM sessions WHERE id = ?').get('s1') as any).repo_path).toBe(newRepoPath);
    expect((raw2.prepare('SELECT repo_path FROM context_cache_project').get() as any).repo_path).toBe(newRepoPath);
    expect((raw2.prepare('SELECT repo_path FROM briefings WHERE id = ?').get('project') as any).repo_path).toBe(newRepoPath);
    expect((raw2.prepare('SELECT repo_path FROM comprehension').get() as any).repo_path).toBe(newRepoPath);
    d2.close();
    try { fs.unlinkSync(tmp); } catch {}
  });
});

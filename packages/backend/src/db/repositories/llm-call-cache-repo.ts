import type BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'crypto';

export interface LlmCallCacheRow {
  repoPath: string;
  phase: string;
  inputHash: string;
  outputJson: string;
  generatedAt: string;
}

/** Generic content-addressable cache for LLM analyzer calls. Backs the
 *  `llmCacheWrap` helper — see ../intelligence/llm-cache.ts. Storing
 *  per-phase + input hash keeps reuse precise: tweaking one input
 *  invalidates only that phase, not the whole pipeline. */
export class LlmCallCacheRepository {
  constructor(private db: BetterSqlite3.Database) {}

  get(repoPath: string, phase: string, inputHash: string): LlmCallCacheRow | null {
    const row = this.db.prepare<[string, string, string]>(
      'SELECT repo_path, phase, input_hash, output_json, generated_at ' +
      'FROM llm_call_cache WHERE repo_path = ? AND phase = ? AND input_hash = ?',
    ).get(repoPath, phase, inputHash) as any;
    if (!row) return null;
    return {
      repoPath: row.repo_path,
      phase: row.phase,
      inputHash: row.input_hash,
      outputJson: row.output_json,
      generatedAt: row.generated_at,
    };
  }

  upsert(repoPath: string, phase: string, inputHash: string, outputJson: string): void {
    this.db.prepare(
      'INSERT INTO llm_call_cache (repo_path, phase, input_hash, output_json) ' +
      'VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (repo_path, phase, input_hash) DO UPDATE SET ' +
      '  output_json = excluded.output_json, generated_at = datetime(\'now\')',
    ).run(repoPath, phase, inputHash, outputJson);
  }

  invalidateRepo(repoPath: string): number {
    const info = this.db.prepare('DELETE FROM llm_call_cache WHERE repo_path = ?').run(repoPath);
    return info.changes;
  }
}

/** Stable hash for arbitrary input shapes. Sorts object keys so the
 *  hash is independent of property order. */
export function hashLlmInputs(inputs: unknown): string {
  const json = JSON.stringify(inputs, replacer);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function replacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

import type { LlmCallCacheRepository } from '../db/repositories/llm-call-cache-repo.js';
import { hashLlmInputs } from '../db/repositories/llm-call-cache-repo.js';

export interface LlmCacheWrapOptions {
  /** Repo for storing/looking up the cached output. */
  cache: LlmCallCacheRepository;
  /** Repo path — keys the cache. Same repo, same inputs → same output. */
  repoPath: string;
  /** Stable name for the call site (e.g. 'cluster-commits'). */
  phase: string;
  /** Anything that uniquely determines the output. Order-independent
   *  (object keys are sorted when hashed). */
  inputs: unknown;
}

/** Cache the result of an LLM call, keyed on (repo, phase, inputs).
 *  Hit → returns cached value without invoking `fn`. Miss → runs `fn`,
 *  persists the result, returns it. Cassettes still work for tests
 *  because they live one layer below (inside the LLMAdapter); this
 *  wrapper sits ABOVE the adapter so a real cache hit avoids even the
 *  cassette-replay roundtrip. */
export async function llmCacheWrap<T>(
  opts: LlmCacheWrapOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const inputHash = hashLlmInputs(opts.inputs);
  const cached = opts.cache.get(opts.repoPath, opts.phase, inputHash);
  if (cached) {
    try {
      return JSON.parse(cached.outputJson) as T;
    } catch {
      // Corrupted row — fall through to regenerate and overwrite.
    }
  }
  const result = await fn();
  opts.cache.upsert(opts.repoPath, opts.phase, inputHash, JSON.stringify(result));
  return result;
}

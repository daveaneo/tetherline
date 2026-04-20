import type { BriefingRepository } from '../db/repositories/briefing-repo.js';
import type { ComprehensionRepository } from '../db/repositories/comprehension-repo.js';
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';
import type { IClaudeClient } from '../intelligence/client-interface.js';
import { BriefingComposer } from './composer.js';

/**
 * Rebuilds briefings from the context cache whenever the underlying summaries
 * have changed. Called at the end of cache warming so briefings are always
 * freshly derived before a session starts asking for them.
 *
 * When `comprehensionRepo` is provided, any briefing whose sourceHash has
 * drifted AND whose comprehension item is at `confirmed` or `explained` is
 * degraded to `heard` — the staleness signal that makes the "tether" visible.
 */
export async function warmBriefings(
  repoPath: string,
  cacheRepo: ContextCacheRepository,
  briefingRepo: BriefingRepository,
  aiClient: IClaudeClient | null = null,
  comprehensionRepo?: ComprehensionRepository,
): Promise<{ written: number; skipped: number; staled: string[] }> {
  const composer = new BriefingComposer(cacheRepo, repoPath, aiClient);
  const proposed = composer.composeAll();

  let written = 0;
  let skipped = 0;
  const staled: string[] = [];
  for (const briefing of proposed) {
    const existing = briefingRepo.get(repoPath, briefing.id);
    if (existing && existing.sourceHash === briefing.sourceHash) {
      skipped += 1;
      continue;
    }
    // sourceHash changed (or new briefing) — staleness signal.
    if (existing && comprehensionRepo) {
      const item = comprehensionRepo.get(repoPath, briefing.id);
      if (item && (item.level === 'confirmed' || item.level === 'explained')) {
        comprehensionRepo.degrade(repoPath, briefing.id, 'heard');
        staled.push(briefing.id);
      }
    }
    briefingRepo.upsert(briefing);
    written += 1;
  }
  return { written, skipped, staled };
}

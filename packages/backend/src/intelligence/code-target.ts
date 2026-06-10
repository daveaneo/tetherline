/**
 * Resolve a spoken target ("capture", "manager.ts", "src/core/capture.ts",
 * a symbol name) to a real file in the repo. Extracted from
 * SessionManager.resolveCodeTarget so the retriever can reuse it; the
 * manager delegates here — zero behavior change.
 */
import fs from 'fs';
import path from 'path';
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveCodeTarget(
  repoPath: string,
  target: string,
  cacheRepo: ContextCacheRepository,
): { filePath: string; symbol?: string } | null {
  // 1. Direct path? (contains "/" or a known code extension at the end)
  const looksLikePath = target.includes('/') || /\.(ts|tsx|js|jsx|py|go|rs|java|kt)$/.test(target);
  if (looksLikePath) {
    const full = path.join(repoPath, target);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { filePath: target };
    }
  }

  // 2 + 3. Search the cached file list. Cheap because it's already in DB.
  const cachedFiles = cacheRepo.getFilesForRepo(repoPath);
  if (cachedFiles.length === 0) return null;

  // 3. Bare filename match (e.g. "manager.ts" → "packages/backend/src/session/manager.ts").
  const byBasename = cachedFiles.find(f => path.basename(f.filePath) === target);
  if (byBasename) return { filePath: byBasename.filePath };

  // 2. Symbol grep. We avoid reading every file — only check candidates
  // whose role looks code-like (entry, route, component, model, utility).
  const candidates = cachedFiles
    .filter(f => /\.(ts|tsx|js|jsx|py|go|rs)$/.test(f.filePath))
    .sort((a, b) => (b.connectivity ?? 0) - (a.connectivity ?? 0))
    .slice(0, 80); // bound the IO

  // Case-insensitive — voice utterances normalize casing; the
  // composer also matches case-insensitively when extracting the
  // symbol from the source.
  const symbolRe = new RegExp(
    `(?:function|class|interface|type|const|def|func|fn)\\s+${escapeForRegex(target)}\\b`,
    'i',
  );
  for (const cand of candidates) {
    try {
      const content = fs.readFileSync(path.join(repoPath, cand.filePath), 'utf8');
      if (symbolRe.test(content)) {
        return { filePath: cand.filePath, symbol: target };
      }
    } catch { /* skip unreadable */ }
  }
  return null;
}

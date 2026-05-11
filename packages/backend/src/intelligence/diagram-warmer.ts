/**
 * Diagram warmer — runs after briefings warm; pre-computes the
 * project + per-module diagrams for both views so first-level
 * radial drilling is instant.
 *
 * Skip-on-fresh: if a cached diagram's source hash matches the
 * recomputed hash, we don't re-LLM. Real cost only on cold-start
 * or after underlying cache drifts (file content / module summary
 * changes).
 */
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';
import type { ComprehensionRepository } from '../db/repositories/comprehension-repo.js';
import type { DiagramCacheRepository } from '../db/repositories/diagram-cache-repo.js';
import type { LLMAdapter } from './llm/index.js';
import {
  extractProjectFileView,
  extractProjectLogicView,
  extractModuleFileView,
  extractModuleLogicView,
} from './diagram-extractor.js';

export interface WarmDiagramsResult {
  written: number;
  skipped: number;
  errors: number;
}

export async function warmDiagrams(
  repoPath: string,
  cacheRepo: ContextCacheRepository,
  diagramRepo: DiagramCacheRepository,
  comprehensionRepo: ComprehensionRepository,
  adapter: LLMAdapter | null,
  onProgress?: (msg: string) => void,
): Promise<WarmDiagramsResult> {
  const params = { repoPath, cacheRepo, comprehensionRepo, adapter };
  let written = 0;
  let skipped = 0;
  let errors = 0;

  const tryWrite = (row: { sourceHash: string; scope: string; view: 'logic' | 'file' } & any) => {
    const existing = diagramRepo.get(row.repoPath, row.scope, row.view);
    if (existing && existing.sourceHash === row.sourceHash) {
      skipped += 1;
      return;
    }
    diagramRepo.upsert(row);
    written += 1;
  };

  // Project file view — no LLM, deterministic. Cheap to recompute, so
  // we don't skip-by-existence here; just rebuild and overwrite if the
  // hash drifted.
  try {
    onProgress?.('Composing project file map...');
    tryWrite(extractProjectFileView(params));
  } catch { errors += 1; }

  // Project logic view — LLM call. Skip ENTIRELY if a cached row exists.
  // The cached row's source_hash includes DIAGRAM_SCHEMA_VERSION, so a
  // schema bump triggers explicit invalidation; otherwise the prior LLM
  // result is reusable. Without this skip the warmer makes a fresh LLM
  // call on every warm session even when nothing changed.
  if (!diagramRepo.get(repoPath, 'project', 'logic')) {
    try {
      onProgress?.('Extracting project conceptual flow...');
      tryWrite(await extractProjectLogicView(params));
    } catch { errors += 1; }
  } else {
    skipped += 1;
  }

  // Per-module diagrams — both views for each top-level module.
  const modules = cacheRepo.getModulesForRepo(repoPath)
    .filter(m => m.confidence >= 0.3)
    .sort((a, b) => (b.impactScore - a.impactScore) || (b.confidence - a.confidence))
    .slice(0, 6);

  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    const scope = `module/${m.modulePath}`;
    const fileCached = !!diagramRepo.get(repoPath, scope, 'file');
    const logicCached = !!diagramRepo.get(repoPath, scope, 'logic');
    if (fileCached && logicCached) {
      skipped += 2;
      continue;
    }
    onProgress?.(`Composing module diagrams (${i + 1}/${modules.length}: ${m.modulePath})...`);
    if (!fileCached) {
      try {
        const fileRow = extractModuleFileView(params, m.modulePath);
        if (fileRow) tryWrite(fileRow);
      } catch { errors += 1; }
    } else { skipped += 1; }
    if (!logicCached) {
      try {
        const logicRow = await extractModuleLogicView(params, m.modulePath);
        if (logicRow) tryWrite(logicRow);
      } catch { errors += 1; }
    } else { skipped += 1; }
  }

  return { written, skipped, errors };
}

/**
 * /api/diagram?repoPath=&scope=&view=  →  pre-warmed payload OR
 * on-the-fly extract on cache miss. The frontend reads through this
 * endpoint; it never needs to know whether the diagram was cached
 * or just composed.
 */
import { Router } from 'express';
import type { Database } from '../db/database.js';
import {
  extractProjectFileView,
  extractProjectLogicView,
  extractModuleFileView,
  extractModuleLogicView,
} from '../intelligence/diagram-extractor.js';
import { getDefaultLLMAdapter } from '../intelligence/llm/index.js';
import { applyComprehension } from '@tetherline/shared';

export function createDiagramRoutes(db: Database): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const repoPath = String(req.query.repoPath ?? '').trim();
    const scope = String(req.query.scope ?? 'project').trim();
    const view = (String(req.query.view ?? 'file').trim() === 'logic' ? 'logic' : 'file') as 'logic' | 'file';
    if (!repoPath) {
      res.status(400).json({ error: 'repoPath query required' });
      return;
    }

    const cached = db.getDiagramCacheRepo().get(repoPath, scope, view);

    // Fast path: cached row exists → serve immediately. The diagram
    // warmer (called at session start, see diagram-warmer.ts) is
    // responsible for keeping cache rows fresh. Doing extraction on
    // the read path triggered 12+ LLM calls per navigation on a
    // 6-module repo even when the cache was valid — the user saw
    // "Generating architecture diagram…" on every view.
    //
    // Schema-version drift is handled by DIAGRAM_SCHEMA_VERSION being
    // mixed into source_hash: when the extractor changes shape, bump
    // the version constant and old rows get re-warmed at session start.
    if (cached) {
      // The diagram cache is STRUCTURE-only (source_hash never tracks
      // comprehension), so cached level/grilled is stale. Overlay the
      // live comprehension store at read time — always-fresh signal
      // with zero cache-key churn. applyComprehension returns clones,
      // so the cached node objects are never mutated.
      const items = db.getComprehensionRepo().getAll(repoPath);
      const fresh = { ...cached, nodes: applyComprehension(cached.nodes, items) };
      res.json({ diagram: fresh, cacheHit: true });
      return;
    }

    // Cold path only: no cached row → run extraction and persist.
    try {
      const params = {
        repoPath,
        cacheRepo: db.getContextCacheRepo(),
        comprehensionRepo: db.getComprehensionRepo(),
        adapter: getDefaultLLMAdapter(),
      };
      let composed: any;
      if (scope === 'project') {
        composed = view === 'logic'
          ? await extractProjectLogicView(params)
          : extractProjectFileView(params);
      } else if (scope.startsWith('module/')) {
        const modulePath = scope.slice('module/'.length);
        composed = view === 'logic'
          ? await extractModuleLogicView(params, modulePath)
          : extractModuleFileView(params, modulePath);
      } else {
        res.status(400).json({ error: `unknown scope: ${scope}` });
        return;
      }
      if (!composed) {
        res.status(404).json({ error: 'no diagram could be composed' });
        return;
      }
      // Cold path: persist the newly extracted diagram for next time.
      db.getDiagramCacheRepo().upsert(composed);
      res.json({ diagram: composed, cacheHit: false });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'diagram extract failed' });
    }
  });

  return router;
}

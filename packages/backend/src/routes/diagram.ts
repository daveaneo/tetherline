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

    // Cache hit — instant.
    const cached = db.getDiagramCacheRepo().get(repoPath, scope, view);
    if (cached) {
      res.json({ diagram: cached, cacheHit: true });
      return;
    }

    // Cache miss — meander territory. Compose on the fly. The user
    // sees a brief loading state while we do this.
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
      // Persist the on-the-fly result so the next visit is instant.
      db.getDiagramCacheRepo().upsert(composed);
      res.json({ diagram: composed, cacheHit: false });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'diagram extract failed' });
    }
  });

  return router;
}

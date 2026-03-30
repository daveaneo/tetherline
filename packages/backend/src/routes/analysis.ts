import { Router } from 'express';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';

export function createAnalysisRoutes(db: Database, _config: AppConfig): Router {
  const router = Router();

  router.post('/start', (req, res) => {
    const { repoPath, sinceDays = 7 } = req.body;
    // TODO: Start analysis pipeline
    res.json({ status: 'started' });
  });

  router.get('/status/:sessionId', (req, res) => {
    // TODO: Return analysis status
    res.json({ status: 'pending' });
  });

  return router;
}

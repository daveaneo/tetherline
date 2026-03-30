import { Router } from 'express';
import type { Database } from '../db/database.js';

export function createSettingsRoutes(db: Database): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const settings = db.getSettingsRepo().getAll();
    res.json({ settings });
  });

  router.put('/', (req, res) => {
    const updates = req.body;
    db.getSettingsRepo().update(updates);
    const settings = db.getSettingsRepo().getAll();
    res.json({ settings });
  });

  return router;
}

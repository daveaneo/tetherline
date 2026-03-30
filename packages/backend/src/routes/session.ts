import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';

export function createSessionRoutes(db: Database, config: AppConfig): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const { repoPath, sinceDays = 7 } = req.body;
    const effectivePath = repoPath || config.repoPath;
    const repoName = effectivePath.split('/').pop() ?? effectivePath;

    // Create a session record so the REST client gets an ID back immediately.
    // The actual analysis is driven by the WebSocket session:start event, but
    // this endpoint lets REST-only callers create a session too.
    const sessionId = uuid();
    const now = new Date();
    const since = new Date(now);
    since.setDate(since.getDate() - sinceDays);

    db.getSessionRepo().createSession({
      id: sessionId,
      repoPath: effectivePath,
      repoName,
      startedAt: now.toISOString(),
      sinceDate: since.toISOString(),
      untilDate: now.toISOString(),
    });

    res.json({ sessionId, status: 'created', repoPath: effectivePath });
  });

  router.get('/', (_req, res) => {
    const sessions = db.getSessionRepo().listSessions();
    res.json({ sessions });
  });

  router.get('/:id', (req, res) => {
    const session = db.getSessionRepo().getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const areas = db.getAreaRepo().getAreasForSession(req.params.id);
    res.json({ session, areas });
  });

  return router;
}

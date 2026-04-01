import { Router } from 'express';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { generateDigest, formatDigestAsMarkdown, formatDigestAsHtml } from '../digest/generator.js';
import { DigestScheduler } from '../digest/scheduler.js';

export function createDigestRoutes(db: Database, config: AppConfig, scheduler: DigestScheduler): Router {
  const router = Router();

  // Get latest digest
  router.get('/latest', (_req, res) => {
    const row = db.getRawDb().prepare(
      'SELECT * FROM digest_history ORDER BY generated_at DESC LIMIT 1'
    ).get() as any;
    if (!row) { res.json({ digest: null }); return; }
    res.json({ digest: JSON.parse(row.content), deliveryStatus: row.delivery_status });
  });

  // Generate a digest now (manual trigger)
  router.post('/generate', async (_req, res) => {
    try {
      const digest = await generateDigest(db, config);
      const appUrl = `http://localhost:${config.port}`;
      const markdown = formatDigestAsMarkdown(digest, appUrl);
      const html = formatDigestAsHtml(digest, appUrl);
      res.json({ digest, markdown, html });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send digest now (manual send)
  router.post('/send', async (_req, res) => {
    try {
      const settings = db.getSettingsRepo().getAll();
      await scheduler.sendDigest((settings as any).digest);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List digest history
  router.get('/history', (_req, res) => {
    const rows = db.getRawDb().prepare(
      'SELECT id, generated_at, period_start, period_end, delivery_status, delivered_at FROM digest_history ORDER BY generated_at DESC LIMIT 10'
    ).all();
    res.json({ digests: rows });
  });

  return router;
}

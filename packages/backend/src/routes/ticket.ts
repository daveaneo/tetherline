/**
 * /api/ticket/* — wires the user-facing "create ticket from this
 * briefing" affordance to the TicketProvider seam. Default provider is
 * GitHub via the gh CLI; falls back to dry-run when not configured.
 */
import { Router } from 'express';
import { getTicketProvider } from '../integrations/ticket-provider.js';
import type { Database } from '../db/database.js';

export function createTicketRoutes(db: Database): Router {
  const router = Router();

  /** POST /api/ticket/create
   *  body: { repoPath, briefingId, projectRef, title?, body? }
   *  Resolves the briefing → uses its title + summary as the issue
   *  body unless the caller overrode them. */
  router.post('/create', async (req, res) => {
    try {
      const { repoPath, briefingId, projectRef, title, body, labels } = req.body ?? {};
      if (!repoPath || !briefingId || !projectRef) {
        res.status(400).json({ error: 'repoPath + briefingId + projectRef required' });
        return;
      }

      // Pull the briefing for default content. If it's a code briefing
      // (which lives only in-memory) we accept the caller's title/body
      // overrides directly.
      let resolvedTitle = title;
      let resolvedBody = body;
      if (!resolvedTitle || !resolvedBody) {
        const briefing = db.getBriefingRepo().get(repoPath, briefingId);
        if (briefing) {
          resolvedTitle = resolvedTitle ?? briefing.title;
          resolvedBody = resolvedBody ?? `${briefing.opener}\n\n— from Tetherline session`;
        }
      }
      if (!resolvedTitle) resolvedTitle = `Ticket from ${briefingId}`;
      if (!resolvedBody) resolvedBody = `Briefing: ${briefingId}`;

      const provider = getTicketProvider();
      const result = await provider.createTicket({
        title: resolvedTitle,
        body: resolvedBody,
        projectRef,
        labels: Array.isArray(labels) ? labels : undefined,
      });

      res.json({
        ok: true,
        provider: result.provider,
        url: result.url,
        externalId: result.externalId,
        title: resolvedTitle,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'ticket create failed' });
    }
  });

  return router;
}

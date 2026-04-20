import { Router } from 'express';
import type { ClientEvent, EntryMode, ModeKey, SessionPhase } from '@tetherline/shared';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { DevSessionRegistry, DevRegistryError } from '../dev/registry.js';
import { devGuard } from '../dev/guard.js';
import { getTraceRecorder } from '../dev/trace.js';

export function createDevRoutes(db: Database, config: AppConfig): Router {
  const router = Router();
  const registry = new DevSessionRegistry(db, config);

  router.use(devGuard);

  // ──────────────────────────────────────────────
  // Session lifecycle
  // ──────────────────────────────────────────────

  /** POST /api/dev/session/start
   *  body: { repoPath, entryMode?, sinceDays? }
   */
  router.post('/session/start', async (req, res) => {
    try {
      const { repoPath, entryMode, sinceDays } = req.body ?? {};
      if (!repoPath || typeof repoPath !== 'string') {
        res.status(400).json({ error: 'repoPath (string) is required' });
        return;
      }

      const devId = registry.create();
      const event: ClientEvent = {
        type: 'session:start',
        payload: {
          repoPath,
          sinceDays: typeof sinceDays === 'number' ? sinceDays : undefined,
          entryMode: entryMode as EntryMode | undefined,
        },
      };
      registry.sendEvent(devId, event);

      // Wait up to 2s for the first state change so callers get a meaningful
      // phase in the response rather than the IDLE default.
      try {
        await registry.waitForEvent(
          devId,
          (e) => e.type === 'session:state_changed',
          2_000,
        );
      } catch { /* swallow — caller can poll if needed */ }

      res.json({
        devSessionId: devId,
        state: registry.getState(devId),
      });
    } catch (err) {
      sendErr(res, err);
    }
  });

  /** POST /api/dev/session/reset { devSessionId } */
  router.post('/session/reset', (req, res) => {
    const id = req.body?.devSessionId ?? req.body?.sessionId;
    if (!id) { res.status(400).json({ error: 'devSessionId is required' }); return; }
    registry.reset(id);
    res.json({ ok: true });
  });

  /** GET /api/dev/session/:id */
  router.get('/session/:id', (req, res) => {
    const session = registry.resolve(req.params.id);
    if (!session) { res.status(404).json({ error: 'session not found', code: 'SESSION_NOT_FOUND' }); return; }
    res.json({
      devSessionId: session.devId,
      backendSessionId: session.backendId,
      state: session.state,
      eventCount: session.events.length,
      areas: session.manager.getAreas().map(a => ({ id: a.id, name: a.name, significance: a.significance })),
      heatmap: session.manager.getHeatmapData(),
    });
  });

  /** GET /api/dev/sessions — list */
  router.get('/sessions', (_req, res) => {
    res.json({ sessions: registry.list() });
  });

  /** POST /api/dev/session/wait
   *  body: { devSessionId, phase, timeoutMs? }
   */
  router.post('/session/wait', async (req, res) => {
    try {
      const { devSessionId, phase, timeoutMs } = req.body ?? {};
      if (!devSessionId || !phase) {
        res.status(400).json({ error: 'devSessionId + phase required' });
        return;
      }
      const state = await registry.waitForPhase(devSessionId, phase as SessionPhase, timeoutMs ?? 30_000);
      res.json({ reached: true, state });
    } catch (err) {
      if (err instanceof DevRegistryError && err.code === 'WAIT_TIMEOUT') {
        res.status(408).json({ error: err.message, code: err.code });
        return;
      }
      sendErr(res, err);
    }
  });

  // ──────────────────────────────────────────────
  // Interaction
  // ──────────────────────────────────────────────

  /** POST /api/dev/utter { devSessionId, text } — inject a text utterance */
  router.post('/utter', (req, res) => {
    try {
      const { devSessionId, text } = req.body ?? {};
      if (!devSessionId || typeof text !== 'string') {
        res.status(400).json({ error: 'devSessionId + text required' });
        return;
      }
      const eventsBefore = registry.getEvents(devSessionId).length;
      const t0 = Date.now();
      registry.sendEvent(devSessionId, {
        type: 'user:utterance',
        payload: { text, timestamp: Date.now() },
      });
      // Give the pipeline a tick to emit synchronous classifications/errors.
      setTimeout(() => {
        const newEvents = registry.getEvents(devSessionId, eventsBefore);
        res.json({
          ok: true,
          elapsedMs: Date.now() - t0,
          newEvents,
          state: registry.getState(devSessionId),
        });
      }, 50);
    } catch (err) {
      sendErr(res, err);
    }
  });

  /** POST /api/dev/command { devSessionId, type } */
  router.post('/command', (req, res) => {
    try {
      const { devSessionId, type } = req.body ?? {};
      if (!devSessionId || !type) { res.status(400).json({ error: 'devSessionId + type required' }); return; }

      const valid = new Set([
        'command:next', 'command:previous', 'command:dive_deeper',
        'command:skip', 'command:pause', 'command:resume',
      ]);
      const fullType = type.startsWith('command:') ? type : `command:${type}`;
      if (!valid.has(fullType)) {
        res.status(400).json({ error: `unknown command: ${fullType}` });
        return;
      }
      const eventsBefore = registry.getEvents(devSessionId).length;
      registry.sendEvent(devSessionId, { type: fullType } as ClientEvent);
      setTimeout(() => {
        res.json({
          ok: true,
          newEvents: registry.getEvents(devSessionId, eventsBefore),
          state: registry.getState(devSessionId),
        });
      }, 50);
    } catch (err) {
      sendErr(res, err);
    }
  });

  /** POST /api/dev/mode { devSessionId, key, enabled } */
  router.post('/mode', (req, res) => {
    try {
      const { devSessionId, key, enabled } = req.body ?? {};
      if (!devSessionId || !key || typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'devSessionId + key + enabled required' });
        return;
      }
      registry.sendEvent(devSessionId, {
        type: 'command:toggle_mode',
        payload: { mode: key as ModeKey, enabled },
      });
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  /** POST /api/dev/export { devSessionId, format } */
  router.post('/export', (req, res) => {
    try {
      const { devSessionId, format } = req.body ?? {};
      if (!devSessionId || !['slides', 'markdown'].includes(format)) {
        res.status(400).json({ error: 'devSessionId + format (slides|markdown) required' });
        return;
      }
      const eventsBefore = registry.getEvents(devSessionId).length;
      registry.sendEvent(devSessionId, {
        type: 'command:export',
        payload: { format: format as 'slides' | 'markdown' },
      });
      // Give export time to run (it's async in session manager).
      setTimeout(() => {
        res.json({
          ok: true,
          newEvents: registry.getEvents(devSessionId, eventsBefore),
        });
      }, 200);
    } catch (err) {
      sendErr(res, err);
    }
  });

  // ──────────────────────────────────────────────
  // Observability
  // ──────────────────────────────────────────────

  /** GET /api/dev/trace?sessionId=&since=&limit= */
  router.get('/trace', (req, res) => {
    const tr = getTraceRecorder();
    if (!tr) { res.json({ events: [] }); return; }
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
    const since = req.query.since ? String(req.query.since) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ events: tr.getEvents({ sessionId, since, limit }) });
  });

  /** GET /api/dev/session/:id/events?since=N */
  router.get('/session/:id/events', (req, res) => {
    const since = req.query.since ? Number(req.query.since) : 0;
    const session = registry.resolve(req.params.id);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    res.json({
      total: session.events.length,
      events: registry.getEvents(req.params.id, since),
    });
  });

  /** GET /api/dev/state — global dev snapshot */
  router.get('/state', (_req, res) => {
    res.json({
      sessions: registry.list(),
      traceBufferSize: getTraceRecorder()?.getEvents().length ?? 0,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'development',
        intelligenceMode: process.env.INTELLIGENCE_MODE ?? 'auto',
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        hasOpenaiKey: !!process.env.OPENAI_API_KEY,
      },
    });
  });

  /** GET /api/dev/ping — liveness for tests */
  router.get('/ping', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // Expose registry to other routers if needed.
  (router as any).__registry = registry;

  return router;
}

function sendErr(res: any, err: unknown) {
  if (err instanceof DevRegistryError) {
    const status = err.code === 'SESSION_NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}

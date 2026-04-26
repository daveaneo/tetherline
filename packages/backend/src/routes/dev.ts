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

  /** POST /api/dev/ask { devSessionId, question } — bypass the intent
   *  classifier and route directly to handleQuestion. Used by tests
   *  that want to assert on Q&A behavior (depth modifiers, length,
   *  scaffold contents) without skill dispatch interfering. */
  router.post('/ask', (req, res) => {
    try {
      const { devSessionId, question } = req.body ?? {};
      if (!devSessionId || typeof question !== 'string') {
        res.status(400).json({ error: 'devSessionId + question required' });
        return;
      }
      const eventsBefore = registry.getEvents(devSessionId).length;
      registry.sendEvent(devSessionId, {
        type: 'command:ask',
        payload: { question },
      } as ClientEvent);
      setTimeout(() => {
        res.json({
          ok: true,
          newEvents: registry.getEvents(devSessionId, eventsBefore),
          state: registry.getState(devSessionId),
        });
      }, 100);
    } catch (err) {
      sendErr(res, err);
    }
  });

  /** POST /api/dev/quiz/answer { devSessionId, questionId, answer } */
  router.post('/quiz/answer', (req, res) => {
    try {
      const { devSessionId, questionId, answer } = req.body ?? {};
      if (!devSessionId || !questionId || typeof answer !== 'string') {
        res.status(400).json({ error: 'devSessionId + questionId + answer required' });
        return;
      }
      const eventsBefore = registry.getEvents(devSessionId).length;
      registry.sendEvent(devSessionId, {
        type: 'user:quiz_answer',
        payload: { questionId, answer },
      } as ClientEvent);
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

  /** POST /api/dev/command { devSessionId, type } */
  router.post('/command', (req, res) => {
    try {
      const { devSessionId, type } = req.body ?? {};
      if (!devSessionId || !type) { res.status(400).json({ error: 'devSessionId + type required' }); return; }

      const valid = new Set([
        'command:next', 'command:previous', 'command:dive_deeper',
        'command:level_up', 'command:skip', 'command:pause', 'command:resume',
        'command:quiz_start',
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

  // ──────────────────────────────────────────────
  // Briefings
  // ──────────────────────────────────────────────

  /** GET /api/dev/briefings?repoPath=&layer= */
  router.get('/briefings', (req, res) => {
    const repoPath = String(req.query.repoPath ?? '');
    if (!repoPath) { res.status(400).json({ error: 'repoPath required' }); return; }
    const layer = req.query.layer ? String(req.query.layer) : undefined;
    if (layer && !['project','architecture','module','file','concept'].includes(layer)) {
      res.status(400).json({ error: `invalid layer: ${layer}` }); return;
    }
    const briefings = layer
      ? db.getBriefingRepo().getByLayer(repoPath, layer as any)
      : db.getBriefingRepo().listAll(repoPath);
    res.json({ briefings });
  });

  /** GET /api/dev/briefing?repoPath=&id=  (id as query so slashes-in-id work) */
  router.get('/briefing', (req, res) => {
    const repoPath = String(req.query.repoPath ?? '');
    const id = String(req.query.id ?? '');
    if (!repoPath || !id) { res.status(400).json({ error: 'repoPath + id required' }); return; }
    const briefing = db.getBriefingRepo().get(repoPath, id);
    if (!briefing) { res.status(404).json({ error: 'briefing not found', code: 'BRIEFING_NOT_FOUND' }); return; }
    res.json({ briefing });
  });

  /** GET /api/dev/navigator?devSessionId= — current nav stack snapshot */
  router.get('/navigator', (req, res) => {
    const devId = String(req.query.devSessionId ?? '');
    if (!devId) { res.status(400).json({ error: 'devSessionId required' }); return; }
    const session = registry.resolve(devId);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    res.json(session.manager.getNavigatorSnapshot());
  });

  /** GET /api/dev/comprehension?repoPath= — comprehension map for a repo */
  router.get('/comprehension', (req, res) => {
    const repoPath = String(req.query.repoPath ?? '');
    if (!repoPath) { res.status(400).json({ error: 'repoPath required' }); return; }
    res.json(db.getComprehensionRepo().buildMap(repoPath));
  });

  /** GET /api/dev/comprehension/multi?repoPaths=a,b — across repos */
  router.get('/comprehension/multi', (req, res) => {
    const raw = String(req.query.repoPaths ?? '');
    const repoPaths = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (repoPaths.length === 0) { res.status(400).json({ error: 'repoPaths required' }); return; }
    res.json({ maps: db.getComprehensionRepo().buildMapAcrossRepos(repoPaths) });
  });

  /** GET /api/dev/voice/metrics?devSessionId= — compute voice metrics from the trace */
  router.get('/voice/metrics', async (req, res) => {
    try {
      const devId = String(req.query.devSessionId ?? '');
      if (!devId) { res.status(400).json({ error: 'devSessionId required' }); return; }
      const session = registry.resolve(devId);
      if (!session) { res.status(404).json({ error: 'session not found' }); return; }

      const { getTraceRecorder } = await import('../dev/trace.js');
      const tr = getTraceRecorder();
      if (!tr) { res.status(503).json({ error: 'trace recorder not running' }); return; }
      const events = tr.getEvents({ sessionId: session.backendId, limit: 2000 });

      const { computeVoiceMetrics, scoreMetrics } = await import('../voice/metrics.js');
      const metrics = computeVoiceMetrics(events);
      const scores = scoreMetrics(metrics);
      res.json({
        metrics,
        scores,
        floor: session.manager.getVoiceFloorState(),
        voiceEventCount: events.filter(e =>
          e.kind.startsWith('user.') || e.kind.startsWith('tts.') || e.kind.startsWith('audio.'),
        ).length,
      });
    } catch (err) {
      sendErr(res, err);
    }
  });

  /** GET /api/dev/challenge/pick?repoPath= — pick a recently-explained item to challenge */
  router.get('/challenge/pick', (req, res) => {
    const repoPath = String(req.query.repoPath ?? '');
    if (!repoPath) { res.status(400).json({ error: 'repoPath required' }); return; }
    const items = db.getComprehensionRepo().getAll(repoPath);
    const candidates = items
      .filter(i => i.level === 'explained')
      .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt));
    if (candidates.length === 0) {
      res.json({ item: null });
      return;
    }
    const picked = candidates[0];
    const briefing = db.getBriefingRepo().get(repoPath, picked.itemId);
    res.json({
      item: picked,
      prompt: `Quick check — in your own words, what does ${picked.label} do?`,
      expectedKeywords: briefing?.talkingPoints ?? [],
    });
  });

  /** POST /api/dev/challenge/evaluate { repoPath, itemId, response } */
  router.post('/challenge/evaluate', (req, res) => {
    try {
      const { repoPath, itemId, response } = req.body ?? {};
      if (!repoPath || !itemId || typeof response !== 'string') {
        res.status(400).json({ error: 'repoPath + itemId + response required' }); return;
      }
      const briefing = db.getBriefingRepo().get(repoPath, itemId);
      const keywords = briefing?.talkingPoints ?? [];
      const normalized = response.toLowerCase();
      const matched = keywords.filter(k => normalized.includes(k.toLowerCase()));
      const ratio = keywords.length === 0 ? 0.5 : matched.length / keywords.length;
      const passed = response.split(/\s+/).length >= 5 && ratio >= 0.3;
      const item = db.getComprehensionRepo().get(repoPath, itemId);
      if (passed && item) {
        db.getComprehensionRepo().observe(
          repoPath, itemId, item.layer, item.label, 'confirmed',
          { sessionId: item.lastSessionId ?? undefined },
        );
      }
      res.json({ passed, ratio, matchedKeywords: matched });
    } catch (err) {
      sendErr(res, err);
    }
  });

  /** POST /api/dev/voice/simulate { sessionId, kind, payload } — inject audio-layer state */
  router.post('/voice/simulate', async (req, res) => {
    try {
      const { devSessionId, kind, payload } = req.body ?? {};
      if (!devSessionId || !kind) { res.status(400).json({ error: 'devSessionId + kind required' }); return; }
      const session = registry.resolve(devSessionId);
      if (!session) { res.status(404).json({ error: 'session not found' }); return; }
      const { getTraceRecorder } = await import('../dev/trace.js');
      const tr = getTraceRecorder();

      // Route simulated audio events through the SAME backend handlers as the
      // real WS path so we test the actual state machine.
      switch (kind) {
        case 'utterance': {
          const text = String((payload as any)?.text ?? '');
          if (!text) { res.status(400).json({ error: 'payload.text required' }); return; }
          session.manager.handleEvent({
            type: 'user:utterance',
            payload: { text, timestamp: Date.now() },
          });
          break;
        }
        case 'segment_finished': {
          const segmentId = String((payload as any)?.segmentId ?? '');
          session.manager.handleEvent({
            type: 'audio:segment_finished',
            payload: { segmentId },
          });
          tr?.emit({ kind: 'audio.segment_ended', sessionId: session.backendId, payload: { segmentId } });
          break;
        }
        case 'segment_started': {
          const segmentId = String((payload as any)?.segmentId ?? '');
          tr?.emit({ kind: 'audio.segment_started', sessionId: session.backendId, payload: { segmentId } });
          break;
        }
        case 'speaking_started': {
          // Emit user.speaking_started BEFORE markUserSpeakingStarted so the
          // tts.queue_flush it produces has a strictly-greater timestamp.
          // The time-to-flush metric requires flush.ts >= speaking_started.ts.
          tr?.emit({ kind: 'user.speaking_started', sessionId: session.backendId, payload: {} });
          session.manager.markUserSpeakingStarted();
          // Auto-ack any currently-playing segment — models what a real
          // frontend does on mic-hot: stops audio, which fires
          // audio:segment_finished back to the server. Gated behind the same
          // env flag as floor suppression so the pre-fix baseline can be
          // reproduced.
          if (tr && process.env.TETHERLINE_DISABLE_FLOOR_SUPPRESSION !== '1') {
            const recent = tr.getEvents({ sessionId: session.backendId, limit: 50 });
            const openSegments = new Set<string>();
            for (const e of recent) {
              if (e.kind === 'audio.segment_started') openSegments.add(String((e.payload as any).segmentId ?? ''));
              else if (e.kind === 'audio.segment_ended') openSegments.delete(String((e.payload as any).segmentId ?? ''));
            }
            for (const id of openSegments) {
              tr.emit({ kind: 'audio.segment_ended', sessionId: session.backendId, payload: { segmentId: id, reason: 'auto_ack_on_speaking' } });
            }
          }
          break;
        }
        case 'speaking_stopped': {
          session.manager.markUserSpeakingStopped();
          tr?.emit({ kind: 'user.speaking_stopped', sessionId: session.backendId, payload: {} });
          break;
        }
        case 'server_narration': {
          // Force the backend to emit an AI-speech event right now — flows
          // through the gated `emit()` wrapper so the gate is actually
          // exercised. Used by voice-measurement scenarios.
          const text = String((payload as any)?.text ?? 'Simulated narration.');
          session.manager.forceEmitNarration(text);
          break;
        }
        case 'interrupt': {
          // Explicit interrupt: equivalent to utterance arriving mid-speech
          const text = String((payload as any)?.text ?? '');
          session.manager.handleEvent({
            type: 'user:utterance',
            payload: { text, timestamp: Date.now() },
          });
          break;
        }
        default:
          res.status(400).json({ error: `unknown kind: ${kind}` });
          return;
      }
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  /** GET /api/dev/briefing/share?repoPath=&id= — render briefing as static HTML */
  router.get('/briefing/share', (req, res) => {
    const repoPath = String(req.query.repoPath ?? '');
    const id = String(req.query.id ?? '');
    if (!repoPath || !id) { res.status(400).json({ error: 'repoPath + id required' }); return; }
    const briefing = db.getBriefingRepo().get(repoPath, id);
    if (!briefing) { res.status(404).json({ error: 'briefing not found' }); return; }
    import('../briefing/share.js').then(({ renderBriefingHTML }) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(renderBriefingHTML(briefing, { repoName: briefing.title }));
    }).catch(err => sendErr(res, err));
  });

  /** POST /api/dev/briefing/rebuild { repoPath } — force rebuild from cache */
  router.post('/briefing/rebuild', async (req, res) => {
    try {
      const { repoPath } = req.body ?? {};
      if (!repoPath) { res.status(400).json({ error: 'repoPath required' }); return; }
      const { warmBriefings } = await import('../briefing/warmer.js');
      const result = await warmBriefings(repoPath, db.getContextCacheRepo(), db.getBriefingRepo(), null);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendErr(res, err);
    }
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

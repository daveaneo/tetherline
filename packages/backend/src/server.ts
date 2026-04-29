import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import path, { dirname } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WS_PATH, API_PREFIX } from '@tetherline/shared';
import { loadConfig, type AppConfig } from './config.js';
import { Database } from './db/database.js';
import { createSessionRoutes } from './routes/session.js';
import { createAnalysisRoutes } from './routes/analysis.js';
import { createExportRoutes } from './routes/export.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createHealthRoutes } from './routes/health.js';
import { createAudioRoutes } from './routes/audio.js';
import { createRepoRoutes } from './routes/repos.js';
import { createTicketRoutes } from './routes/ticket.js';
import { createDiagramRoutes } from './routes/diagram.js';
import { GitHubTicketProvider } from './integrations/github-provider.js';
import { setTicketProvider } from './integrations/ticket-provider.js';
import { createOnboardingRoutes } from './routes/onboarding.js';
import { createDigestRoutes } from './routes/digest.js';
import { createDevRoutes } from './routes/dev.js';
import { DigestScheduler } from './digest/scheduler.js';
import { handleWebSocket } from './ws/handler.js';
import { TraceRecorder, setTraceRecorder } from './dev/trace.js';

export async function createServer(overrides: { port?: number; repoPath?: string } = {}): Promise<{ app: express.Express; wss: WebSocketServer; server: http.Server; db: Database; config: AppConfig; digestScheduler: DigestScheduler }> {
  const config = loadConfig(overrides);

  // Ensure data directories exist
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.audioCachePath, { recursive: true });

  // Initialize database
  const db = new Database(config.dbPath);

  // Trace recorder (gated on NODE_ENV !== 'production')
  if (process.env.NODE_ENV !== 'production' || process.env.TETHERLINE_ALLOW_DEV === '1') {
    setTraceRecorder(new TraceRecorder(config.dataDir));
  }

  // Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // API routes
  const router = express.Router();
  router.use('/health', createHealthRoutes());
  router.use('/sessions', createSessionRoutes(db, config));
  router.use('/analysis', createAnalysisRoutes(db, config));
  router.use('/export', createExportRoutes(db, config));
  router.use('/settings', createSettingsRoutes(db));
  router.use('/audio', createAudioRoutes(db, config));
  router.use('/repos', createRepoRoutes(db, config));

  // Ticket integration: dry-run by default unless TETHERLINE_TICKETS_LIVE=1.
  // Avoids creating real GitHub issues from local dev experimentation.
  setTicketProvider(new GitHubTicketProvider({
    dryRun: process.env.TETHERLINE_TICKETS_LIVE !== '1',
  }));
  router.use('/ticket', createTicketRoutes(db));
  router.use('/diagram', createDiagramRoutes(db));
  router.use('/onboarding', createOnboardingRoutes(db, config));
  const digestScheduler = new DigestScheduler(db, config);
  router.use('/digest', createDigestRoutes(db, config, digestScheduler));

  // Dev-only routes (gated on NODE_ENV + loopback)
  if (process.env.NODE_ENV !== 'production' || process.env.TETHERLINE_ALLOW_DEV === '1') {
    router.use('/dev', createDevRoutes(db, config));
  }

  // Annotations endpoint
  router.get('/annotations', (req, res) => {
    const repoPath = req.query.repoPath as string;
    if (!repoPath) { res.status(400).json({ error: 'repoPath required' }); return; }
    const rows = db.getRawDb().prepare(
      'SELECT * FROM annotations WHERE repo_path = ? ORDER BY created_at DESC'
    ).all(repoPath);
    res.json({ annotations: rows });
  });

  app.use(API_PREFIX, router);

  // Serve frontend static files in production
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist, {
      // Hashed assets get long cache, index.html always revalidates
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  // HTTP server
  const server = http.createServer(app);

  // WebSocket server
  const wss = new WebSocketServer({ server, path: WS_PATH });
  wss.on('connection', (ws) => {
    handleWebSocket(ws, db, config);
  });

  return { app, wss, server, db, config, digestScheduler };
}

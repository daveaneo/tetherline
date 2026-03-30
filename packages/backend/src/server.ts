import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import path, { dirname } from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WS_PATH, API_PREFIX } from '@interactive-reviewer/shared';
import { loadConfig, type AppConfig } from './config.js';
import { Database } from './db/database.js';
import { createSessionRoutes } from './routes/session.js';
import { createAnalysisRoutes } from './routes/analysis.js';
import { createExportRoutes } from './routes/export.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createHealthRoutes } from './routes/health.js';
import { createAudioRoutes } from './routes/audio.js';
import { handleWebSocket } from './ws/handler.js';

export async function createServer(overrides: { port?: number; repoPath?: string } = {}): Promise<{ app: express.Express; wss: WebSocketServer; server: http.Server; db: Database; config: AppConfig }> {
  const config = loadConfig(overrides);

  // Ensure data directories exist
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.audioCachePath, { recursive: true });

  // Initialize database
  const db = new Database(config.dbPath);

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
  app.use(API_PREFIX, router);

  // Serve frontend static files in production
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get('*', (_req, res) => {
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

  return { app, wss, server, db, config };
}

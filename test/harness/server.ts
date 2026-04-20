import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer as createBackendServer } from '../../packages/backend/src/server.js';
import type { AppConfig } from '../../packages/backend/src/config.js';
import type { Database } from '../../packages/backend/src/db/database.js';
import type express from 'express';
import type http from 'http';
import type { WebSocketServer } from 'ws';

export interface HarnessServer {
  baseUrl: string;
  port: number;
  dataDir: string;
  app: express.Express;
  http: http.Server;
  wss: WebSocketServer;
  db: Database;
  config: AppConfig;
  stop: () => Promise<void>;
}

/**
 * Start the Tetherline backend on an ephemeral port with a tmp data dir.
 * Safe to run many times in parallel — no global state shared between harnesses
 * except the LLM default adapter, which tests should install themselves.
 */
export async function startHarnessServer(): Promise<HarnessServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tetherline-test-'));
  process.env.TETHERLINE_DATA_DIR_OVERRIDE = dataDir;
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

  const created = await createBackendServer({ port: 0 });

  // Override dataDir on the running config (has already been used to init DB/audioCache).
  // The TraceRecorder already wrote to the real config.dataDir; tests that assert on
  // trace JSONL files should read from `created.config.dataDir` explicitly.

  const server = created.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server.address() unexpected');
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    port,
    dataDir: created.config.dataDir,
    app: created.app,
    http: server,
    wss: created.wss,
    db: created.db,
    config: created.config,
    stop: async () => {
      await new Promise<void>((res) => server.close(() => res()));
      created.digestScheduler.stop?.();
      created.db.close?.();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

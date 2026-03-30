import type { WebSocket } from 'ws';
import type { ClientEvent, ServerEvent } from '@interactive-reviewer/shared';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { SessionManager } from '../session/manager.js';

export function handleWebSocket(ws: WebSocket, db: Database, config: AppConfig) {
  const sessionManager = new SessionManager(db, config, (event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString()) as ClientEvent;
      sessionManager.handleEvent(event);
    } catch (err) {
      console.error('Invalid WebSocket message:', err);
      ws.send(JSON.stringify({
        type: 'error',
        payload: { code: 'INVALID_MESSAGE', message: 'Invalid message format', recoverable: true },
      }));
    }
  });

  ws.on('close', () => {
    sessionManager.cleanup();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
}

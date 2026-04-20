import { randomBytes } from 'crypto';
import type { ClientEvent, ServerEvent, SessionState } from '@tetherline/shared';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { SessionManager } from '../session/manager.js';
import { getTraceRecorder } from './trace.js';

interface DevSession {
  devId: string;
  backendId: string | null;
  manager: SessionManager;
  events: ServerEvent[];
  state: SessionState;
  createdAt: Date;
  subscribers: Set<(event: ServerEvent) => void>;
}

const SWEEP_AFTER_IDLE_MS = 10 * 60_000; // 10 min

/**
 * Keeps SessionManager instances alive outside the WS flow so dev-API endpoints
 * can drive them via plain HTTP. Each session gets a stable devId; the backend
 * session id (assigned when analysis starts) is tracked in parallel so calls
 * against either id resolve correctly.
 */
export class DevSessionRegistry {
  private sessions = new Map<string, DevSession>();
  private backendToDev = new Map<string, string>();

  constructor(private db: Database, private config: AppConfig) {
    setInterval(() => this.sweepIdle(), 60_000).unref?.();
  }

  create(): string {
    const devId = `dev_${randomBytes(8).toString('hex')}`;
    const session: DevSession = {
      devId,
      backendId: null,
      manager: null as unknown as SessionManager,
      events: [],
      state: { phase: 'IDLE' },
      createdAt: new Date(),
      subscribers: new Set(),
    };
    session.manager = new SessionManager(this.db, this.config, (event) => this.onEmit(session, event));
    this.sessions.set(devId, session);
    return devId;
  }

  private onEmit(session: DevSession, event: ServerEvent) {
    session.events.push(event);

    // Track backend-assigned session id for lookup by either id.
    if (event.type === 'analysis:started' && event.payload.sessionId) {
      session.backendId = event.payload.sessionId;
      this.backendToDev.set(event.payload.sessionId, session.devId);
    }

    // Keep latest state in sync.
    if (event.type === 'session:state_changed') {
      session.state = event.payload.state;
      const tr = getTraceRecorder();
      tr?.emit({
        kind: 'phase.changed',
        sessionId: session.backendId,
        payload: { phase: event.payload.state.phase, context: event.payload.context },
      });
    }
    if (event.type === 'narration:segment_ready') {
      getTraceRecorder()?.emit({
        kind: 'narration.emitted',
        sessionId: session.backendId,
        payload: { segmentId: event.payload.segment.id, text: event.payload.segment.text },
      });
    }
    if (event.type.startsWith('visual:')) {
      getTraceRecorder()?.emit({
        kind: 'visual.update',
        sessionId: session.backendId,
        payload: { eventType: event.type, ...event.payload },
      });
    }
    if (event.type === 'error') {
      getTraceRecorder()?.emit({
        kind: 'error',
        sessionId: session.backendId,
        payload: event.payload,
      });
    }

    for (const sub of session.subscribers) {
      try { sub(event); } catch { /* subscriber failed */ }
    }
  }

  resolve(id: string): DevSession | null {
    if (this.sessions.has(id)) return this.sessions.get(id)!;
    const devId = this.backendToDev.get(id);
    return devId ? this.sessions.get(devId) ?? null : null;
  }

  list(): Array<Pick<DevSession, 'devId' | 'backendId' | 'state' | 'createdAt'>> {
    return [...this.sessions.values()].map(s => ({
      devId: s.devId,
      backendId: s.backendId,
      state: s.state,
      createdAt: s.createdAt,
    }));
  }

  sendEvent(id: string, event: ClientEvent): void {
    const session = this.resolve(id);
    if (!session) throw new DevRegistryError('SESSION_NOT_FOUND', `No session for id ${id}`);
    getTraceRecorder()?.emit({
      kind: event.type === 'user:utterance' ? 'utterance.received' : 'utterance.received',
      sessionId: session.backendId,
      payload: { clientEvent: event },
    });
    session.manager.handleEvent(event);
  }

  getState(id: string): SessionState | null {
    return this.resolve(id)?.state ?? null;
  }

  getEvents(id: string, sinceCount = 0): ServerEvent[] {
    const session = this.resolve(id);
    if (!session) return [];
    return session.events.slice(sinceCount);
  }

  getAreas(id: string) {
    return this.resolve(id)?.manager.getAreas() ?? [];
  }

  getHeatmap(id: string) {
    return this.resolve(id)?.manager.getHeatmapData() ?? null;
  }

  /** Wait until the session reaches the target phase (or timeout). */
  waitForPhase(id: string, phase: SessionState['phase'], timeoutMs = 30_000): Promise<SessionState> {
    const session = this.resolve(id);
    if (!session) return Promise.reject(new DevRegistryError('SESSION_NOT_FOUND', `No session for id ${id}`));
    if (session.state.phase === phase) return Promise.resolve(session.state);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.subscribers.delete(handler);
        reject(new DevRegistryError('WAIT_TIMEOUT', `timed out waiting for phase=${phase} after ${timeoutMs}ms (current=${session.state.phase})`));
      }, timeoutMs);
      const handler = (event: ServerEvent) => {
        if (event.type === 'session:state_changed' && event.payload.state.phase === phase) {
          clearTimeout(timer);
          session.subscribers.delete(handler);
          resolve(event.payload.state);
        }
      };
      session.subscribers.add(handler);
    });
  }

  /** Wait until any server event matching a predicate arrives. */
  waitForEvent<T extends ServerEvent['type']>(
    id: string,
    predicate: (event: ServerEvent) => boolean,
    timeoutMs = 30_000,
  ): Promise<ServerEvent> {
    const session = this.resolve(id);
    if (!session) return Promise.reject(new DevRegistryError('SESSION_NOT_FOUND', `No session for id ${id}`));

    // Short-circuit if a recent event already matches
    const existing = session.events.slice(-20).find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.subscribers.delete(handler);
        reject(new DevRegistryError('WAIT_TIMEOUT', `timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (event: ServerEvent) => {
        if (predicate(event)) {
          clearTimeout(timer);
          session.subscribers.delete(handler);
          resolve(event);
        }
      };
      session.subscribers.add(handler);
    });
  }

  reset(id: string): void {
    const session = this.resolve(id);
    if (!session) return;
    try { session.manager.cleanup(); } catch { /* ignore */ }
    if (session.backendId) this.backendToDev.delete(session.backendId);
    this.sessions.delete(session.devId);
  }

  private sweepIdle() {
    const now = Date.now();
    for (const [devId, session] of this.sessions) {
      if (now - session.createdAt.getTime() > SWEEP_AFTER_IDLE_MS) {
        try { session.manager.cleanup(); } catch {}
        if (session.backendId) this.backendToDev.delete(session.backendId);
        this.sessions.delete(devId);
      }
    }
  }
}

export class DevRegistryError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

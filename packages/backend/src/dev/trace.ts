import { mkdirSync, createWriteStream, type WriteStream } from 'fs';
import path from 'path';

export type TraceKind =
  | 'utterance.received'
  | 'intent.classified'
  | 'llm.request'
  | 'llm.response'
  | 'skill.started'
  | 'skill.completed'
  | 'skill.failed'
  | 'tts.requested'
  | 'tts.first_audio'
  | 'tts.completed'
  | 'tts.emit'              // server emitted a narration event (any kind)
  | 'tts.queue_flush'       // queue cleared in response to user speech
  | 'tts.drop'              // narration suppressed because user holds the floor
  | 'user.speaking_started' // mic voice activity began
  | 'user.speaking_stopped' // mic voice activity ended
  | 'audio.segment_started' // client started playing a segment
  | 'audio.segment_ended'   // client finished playing a segment
  | 'narration.emitted'
  | 'phase.changed'
  | 'visual.update'
  | 'error';

export interface TraceEvent {
  id: string;
  sessionId: string | null;
  ts: string; // ISO
  kind: TraceKind;
  durationMs?: number;
  payload: Record<string, unknown>;
}

const MAX_RING = 1000;

export class TraceRecorder {
  private ring: TraceEvent[] = [];
  private counter = 0;
  private writeStream: WriteStream | null = null;
  private currentDay: string | null = null;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'trace');
    mkdirSync(this.dir, { recursive: true });
  }

  emit(event: Omit<TraceEvent, 'id' | 'ts'> & { ts?: string }): TraceEvent {
    const ts = event.ts ?? new Date().toISOString();
    const id = `trc_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
    const full: TraceEvent = { ...event, id, ts };
    this.ring.push(full);
    if (this.ring.length > MAX_RING) this.ring.shift();
    this.writeJsonl(full);
    return full;
  }

  private writeJsonl(event: TraceEvent) {
    const day = event.ts.slice(0, 10);
    if (this.currentDay !== day) {
      this.writeStream?.end();
      this.currentDay = day;
      this.writeStream = createWriteStream(path.join(this.dir, `${day}.jsonl`), { flags: 'a' });
    }
    this.writeStream?.write(JSON.stringify(event) + '\n');
  }

  /** Span helper — emit `kind.started`/`.completed` pair with durationMs. */
  async span<T>(
    kind: Extract<TraceKind, `${string}.started` | 'skill.started'>,
    sessionId: string | null,
    payload: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = this.emit({ kind, sessionId, payload });
    const t0 = Date.now();
    try {
      const result = await fn();
      const completedKind = kind.replace('.started', '.completed') as TraceKind;
      this.emit({
        kind: completedKind,
        sessionId,
        payload,
        durationMs: Date.now() - t0,
      });
      void started;
      return result;
    } catch (err) {
      const failedKind = kind.replace('.started', '.failed') as TraceKind;
      this.emit({
        kind: failedKind,
        sessionId,
        payload: { ...payload, error: err instanceof Error ? err.message : String(err) },
        durationMs: Date.now() - t0,
      });
      throw err;
    }
  }

  getEvents(opts: { sessionId?: string | null; since?: string; limit?: number } = {}): TraceEvent[] {
    let events = this.ring;
    if (opts.since) events = events.filter(e => e.ts >= opts.since!);
    if (opts.sessionId !== undefined) events = events.filter(e => e.sessionId === opts.sessionId);
    if (opts.limit) events = events.slice(-opts.limit);
    return events;
  }

  clear() {
    this.ring = [];
  }

  /** Close and flush the JSONL file handle. Returns a promise that resolves
   *  once the stream has finished writing — important for tests that read the
   *  file immediately after close(). */
  async close(): Promise<void> {
    const s = this.writeStream;
    this.writeStream = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.end(resolve));
  }
}

// Singleton, set up by server.ts after config is known.
let _recorder: TraceRecorder | null = null;

export function setTraceRecorder(r: TraceRecorder) {
  _recorder = r;
}

export function getTraceRecorder(): TraceRecorder | null {
  return _recorder;
}

export function trace(event: Omit<TraceEvent, 'id' | 'ts'> & { ts?: string }): void {
  _recorder?.emit(event);
}

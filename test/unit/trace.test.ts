import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TraceRecorder } from '../../packages/backend/src/dev/trace.js';

describe('TraceRecorder', () => {
  it('emits events with ids and timestamps', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
    const r = new TraceRecorder(dir);

    const evt = r.emit({ kind: 'phase.changed', sessionId: 's1', payload: { phase: 'PROPOSAL' } });
    expect(evt.id).toMatch(/^trc_/);
    expect(evt.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(evt.payload.phase).toBe('PROPOSAL');

    await r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('filters events by sessionId', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
    const r = new TraceRecorder(dir);

    r.emit({ kind: 'phase.changed', sessionId: 'a', payload: {} });
    r.emit({ kind: 'phase.changed', sessionId: 'b', payload: {} });
    r.emit({ kind: 'phase.changed', sessionId: 'a', payload: {} });

    const a = r.getEvents({ sessionId: 'a' });
    expect(a).toHaveLength(2);

    await r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSONL to disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
    const r = new TraceRecorder(dir);

    r.emit({ kind: 'llm.response', sessionId: null, payload: { id: 'abc' } });
    await r.close();

    const traceDir = path.join(dir, 'trace');
    const files = fs.readdirSync(traceDir).filter(f => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(traceDir, files[0]), 'utf8');
    expect(content).toContain('"kind":"llm.response"');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

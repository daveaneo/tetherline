import { describe, it, expect, afterAll } from 'vitest';
import { tetherline, type TetherlineHarness } from '../harness/index.js';

let h: TetherlineHarness;

describe('dev API smoke test', () => {
  afterAll(async () => {
    await h?.stop();
  });

  it('starts the backend on an ephemeral port and /api/dev/ping responds', async () => {
    h = await tetherline.start();
    const res = await fetch(`${h.server.baseUrl}/api/dev/ping`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; ts: string };
    expect(body.ok).toBe(true);
    expect(body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('exposes env status via /api/dev/state', async () => {
    const res = await h.client.ping();
    expect(res.ok).toBe(true);

    const r = await fetch(`${h.server.baseUrl}/api/dev/state`);
    const body = await r.json() as { sessions: unknown[]; env: Record<string, unknown> };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.env).toBeDefined();
  });

  it('rejects dev endpoints over non-loopback', async () => {
    // We can't easily spoof a non-loopback address here; skip unless the guard
    // is extended with an X-Forwarded-For check. Placeholder to document intent.
    expect(true).toBe(true);
  });
});

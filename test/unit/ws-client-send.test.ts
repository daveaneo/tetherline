/**
 * sendEvent contract (R6): it must REPORT delivery, not silently drop.
 * Optimistic UI ("thinking…") keys off this — a dropped send that
 * returns true would strand the user on a spinner forever.
 */
import { describe, it, expect, vi } from 'vitest';
import { sendEvent, setWsInstance } from '../../packages/frontend/src/lib/ws-client.js';

function fakeWs(readyState: number) {
  return { readyState, send: vi.fn() } as unknown as WebSocket;
}

describe('ws-client sendEvent', () => {
  it('returns true and serializes when the socket is OPEN', () => {
    const ws = fakeWs(WebSocket.OPEN);
    setWsInstance(ws);
    const ok = sendEvent({ type: 'command:next' });
    expect(ok).toBe(true);
    expect((ws.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(JSON.stringify({ type: 'command:next' }));
  });

  it('returns false and does not throw when the socket is not open', () => {
    const ws = fakeWs(WebSocket.CLOSED);
    setWsInstance(ws);
    expect(sendEvent({ type: 'command:next' })).toBe(false);
    expect((ws.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

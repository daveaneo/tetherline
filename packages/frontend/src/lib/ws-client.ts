import type { ClientEvent } from '@tetherline/shared';

let wsInstance: WebSocket | null = null;

export function setWsInstance(ws: WebSocket) {
  wsInstance = ws;
}

/** Send an event to the backend. Returns false when the socket isn't
 *  open (event dropped) — callers that show optimistic UI ("thinking…")
 *  MUST check this, or a disconnect leaves the user staring at a
 *  spinner for a reply that was never sent. No queue on purpose:
 *  replaying stale commands after a reconnect is worse than telling
 *  the user to retry. */
export function sendEvent(event: ClientEvent): boolean {
  if (wsInstance?.readyState === WebSocket.OPEN) {
    wsInstance.send(JSON.stringify(event));
    return true;
  }
  return false;
}

import type { ClientEvent } from '@tetherline/shared';

let wsInstance: WebSocket | null = null;

export function setWsInstance(ws: WebSocket) {
  wsInstance = ws;
}

export function sendEvent(event: ClientEvent) {
  if (wsInstance?.readyState === WebSocket.OPEN) {
    wsInstance.send(JSON.stringify(event));
  }
}

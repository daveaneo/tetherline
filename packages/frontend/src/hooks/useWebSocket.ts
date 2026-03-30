import { useEffect, useRef, useCallback, useState } from 'react';
import type { ClientEvent, ServerEvent } from '@interactive-reviewer/shared';
import { WS_PATH } from '@interactive-reviewer/shared';
import { useSessionStore } from '../state/session-store.js';
import { setWsInstance } from '../lib/ws-client.js';

const MAX_BACKOFF_MS = 10_000;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const handleServerEvent = useSessionStore(s => s.handleServerEvent);
  const setStoreConnected = useSessionStore(s => s.setConnected);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${WS_PATH}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsInstance(ws);
      setConnected(true);
      setReconnecting(false);
      setStoreConnected(true);
      retriesRef.current = 0;
      console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const serverEvent = JSON.parse(event.data) as ServerEvent;
        handleServerEvent(serverEvent);
      } else {
        // Binary frame: audio data
        // TODO: Route to audio store
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setStoreConnected(false);
      console.log('WebSocket disconnected');

      if (!unmountedRef.current) {
        setReconnecting(true);
        const delay = Math.min(1000 * Math.pow(2, retriesRef.current), MAX_BACKOFF_MS);
        retriesRef.current += 1;
        console.log(`Reconnecting in ${delay}ms (attempt ${retriesRef.current})...`);
        timerRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }, [handleServerEvent, setStoreConnected]);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((event: ClientEvent) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event));
    }
  }, []);

  return { connected, reconnecting, send, ws: wsRef };
}

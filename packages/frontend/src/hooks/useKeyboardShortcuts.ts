import { useEffect } from 'react';
import { sendEvent } from '../lib/ws-client.js';
import { useSessionStore } from '../state/session-store.js';

export function useKeyboardShortcuts() {
  const state = useSessionStore(s => s.state);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture when typing in input fields
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          sendEvent({ type: 'command:next' });
          break;
        case 'ArrowLeft':
          e.preventDefault();
          sendEvent({ type: 'command:previous' });
          break;
        case ' ':
          e.preventDefault();
          sendEvent(state.paused ? { type: 'command:resume' } : { type: 'command:pause' });
          break;
        case 'd':
        case 'D':
          sendEvent({ type: 'command:dive_deeper' });
          break;
        case 's':
        case 'S':
          sendEvent({ type: 'command:skip' });
          break;
        case 'q':
        case 'Q':
          // TODO: Open question panel
          break;
        case 'c':
        case 'C':
          sendEvent({ type: 'command:toggle_mode', payload: { mode: 'advisory', enabled: true } });
          break;
        case 'Escape':
          // If in QA, dismiss
          if (state.phase === 'QA') {
            sendEvent({ type: 'command:next' });
          }
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state]);
}

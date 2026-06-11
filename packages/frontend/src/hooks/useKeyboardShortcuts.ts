import { useEffect } from 'react';
import { sendEvent } from '../lib/ws-client.js';
import { useSessionStore } from '../state/session-store.js';

export function useKeyboardShortcuts() {
  const state = useSessionStore(s => s.state);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture when typing in input fields / editable surfaces
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
      // Bare-letter hotkeys drive the SESSION — outside one (lobby) or
      // before there's anything to navigate (analyzing), a stray
      // keypress must not fire commands into the void.
      if (state.phase === 'IDLE' || state.phase === 'ANALYZING') return;
      // Modified keypresses are someone else's shortcut (Cmd+S, Ctrl+D…).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

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
          // Spacebar is owned by the push-to-talk handler in useVoiceInput.
          // A short tap there sends pause/resume; a hold engages the mic.
          // Don't double-handle here.
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

/**
 * Multi-layer interrupt system.
 * Guarantees the AI stops speaking when the user wants attention.
 *
 * Layer 1: Any keypress (not in input fields)
 * Layer 2: Click on the narration bar area (bottom 100px)
 * Layer 3: Scroll wheel
 * Layer 4: Audio VAD (handled by AudioCapture separately)
 *
 * After interrupting, enforces a 1.5s backoff where the AI can't resume
 * speaking, giving the user time to finish their thought.
 */
import { useEffect } from 'react';
import { useAudioStore } from '../state/audio-store.js';
import { sendEvent } from '../lib/ws-client.js';

const BACKOFF_MS = 1500;

function interrupt(source: string) {
  const store = useAudioStore.getState();

  // Only interrupt if the AI is actually speaking
  if (!store.isPlaying) return;

  // INSTANT local kill — no WebSocket round-trip needed
  store.muteOutput();
  store.setPlaying(false);
  store.setVoiceState('listening');

  // Enforce backoff — prevent AI from speaking for 1.5s
  store.setInterruptBackoff(Date.now() + BACKOFF_MS);

  // Notify backend (for state tracking, not for audio stopping)
  sendEvent({ type: 'command:pause' });

  // Debug toast
  store.addSpeechToast(`[interrupted: ${source}]`);
}

export function useInterrupt() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      interrupt('keypress');
    }

    function handleClick(e: MouseEvent) {
      // Bottom 100px of screen = narration bar area
      if (e.clientY > window.innerHeight - 100) {
        interrupt('click');
      }
    }

    function handleScroll() {
      interrupt('scroll');
    }

    // Use capture phase to fire before any other handlers
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('click', handleClick, { capture: true });
    window.addEventListener('wheel', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('click', handleClick, { capture: true });
      window.removeEventListener('wheel', handleScroll);
    };
  }, []);
}

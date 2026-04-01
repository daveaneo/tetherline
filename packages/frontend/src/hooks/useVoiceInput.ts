import { useEffect, useRef, useCallback, useState } from 'react';
import { VoiceCommandRecognizer, type VoiceCommand } from '../lib/speech-recognition.js';
import { sendEvent } from '../lib/ws-client.js';
import { useSessionStore } from '../state/session-store.js';
import { useAudioStore } from '../state/audio-store.js';

const COMMAND_TO_EVENT: Record<VoiceCommand, () => void> = {
  next: () => sendEvent({ type: 'command:next' }),
  previous: () => sendEvent({ type: 'command:previous' }),
  dive_deeper: () => sendEvent({ type: 'command:dive_deeper' }),
  skip: () => sendEvent({ type: 'command:skip' }),
  pause: () => sendEvent({ type: 'command:pause' }),
  resume: () => sendEvent({ type: 'command:resume' }),
  show_concerns: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'advisory', enabled: true } }),
};

export function useVoiceInput() {
  const recognizerRef = useRef<VoiceCommandRecognizer | null>(null);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const recognizer = new VoiceCommandRecognizer();
    recognizerRef.current = recognizer;
    setSupported(recognizer.isSupported());

    recognizer.onSpeechStart = () => {
      const audioStore = useAudioStore.getState();
      audioStore.setVoiceState('hearing');

      // INTERRUPT: if the AI is speaking, pause it immediately
      if (audioStore.isPlaying) {
        sendEvent({ type: 'command:pause' });
      }
    };

    recognizer.onSpeechEnd = () => {
      // Brief transition to processing while we wait for the transcript
      const audioStore = useAudioStore.getState();
      if (audioStore.voiceState === 'hearing') {
        audioStore.setVoiceState('processing');
      }
    };

    recognizer.onCommand = (command) => {
      useAudioStore.getState().setVoiceState('processing');
      COMMAND_TO_EVENT[command]?.();
      // Brief processing state, then back to listening
      setTimeout(() => {
        const store = useAudioStore.getState();
        if (store.voiceState === 'processing') store.setVoiceState('listening');
      }, 500);
    };

    recognizer.onQuestion = (question) => {
      sendEvent({ type: 'command:ask', payload: { question } });
    };

    recognizer.onUtterance = (text) => {
      useAudioStore.getState().setVoiceState('processing');
      sendEvent({ type: 'user:utterance', payload: { text, timestamp: Date.now() } });
      // Processing state stays until AI responds (setPlaying(true) will change it to 'speaking')
    };

    return () => {
      recognizer.stop();
    };
  }, []);

  // Auto-start voice recognition when entering a session, auto-stop when returning to IDLE
  const phase = useSessionStore(s => s.state.phase);

  useEffect(() => {
    if (!recognizerRef.current || !recognizerRef.current.isSupported()) return;
    if (phase !== 'IDLE' && !listening) {
      try {
        recognizerRef.current.start();
        setListening(true);
      } catch {
        // Speech recognition may throw if already started or not allowed
      }
    } else if (phase === 'IDLE' && listening) {
      recognizerRef.current.stop();
      setListening(false);
    }
    // Only react to phase changes — listening is intentionally excluded to avoid loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const toggleListening = useCallback(() => {
    if (!recognizerRef.current) return;
    if (listening) {
      recognizerRef.current.stop();
      setListening(false);
    } else {
      recognizerRef.current.start();
      setListening(true);
    }
  }, [listening]);

  return { listening, toggleListening, supported };
}

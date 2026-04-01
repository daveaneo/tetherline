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
      const audioStore = useAudioStore.getState();
      if (audioStore.voiceState === 'hearing') {
        audioStore.setVoiceState('processing');
      }
    };

    recognizer.onCommand = (command) => {
      const audioStore = useAudioStore.getState();
      audioStore.setVoiceState('processing');
      audioStore.addSpeechToast(`"${command}"`);
      COMMAND_TO_EVENT[command]?.();
      setTimeout(() => {
        const store = useAudioStore.getState();
        if (store.voiceState === 'processing') store.setVoiceState('listening');
      }, 500);
    };

    recognizer.onQuestion = (question) => {
      useAudioStore.getState().addSpeechToast(question);
      sendEvent({ type: 'command:ask', payload: { question } });
    };

    recognizer.onUtterance = (text) => {
      const audioStore = useAudioStore.getState();
      audioStore.setVoiceState('processing');
      audioStore.addSpeechToast(text);
      sendEvent({ type: 'user:utterance', payload: { text, timestamp: Date.now() } });
    };

    return () => {
      recognizer.stop();
    };
  }, []);

  // Register startListening with the audio store so Lobby can call it from a click handler
  const startListening = useCallback(() => {
    if (!recognizerRef.current || listening) return;
    try {
      recognizerRef.current.start();
      setListening(true);
    } catch {
      // Already started or not allowed
    }
  }, [listening]);

  useEffect(() => {
    useAudioStore.getState().setStartMicFn(startListening);
  }, [startListening]);

  // Auto-stop when returning to IDLE
  const phase = useSessionStore(s => s.state.phase);
  useEffect(() => {
    if (phase === 'IDLE' && listening && recognizerRef.current) {
      recognizerRef.current.stop();
      setListening(false);
    }
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

  return { listening, toggleListening, startListening, supported };
}

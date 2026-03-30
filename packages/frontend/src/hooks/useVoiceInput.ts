import { useEffect, useRef, useCallback, useState } from 'react';
import { VoiceCommandRecognizer, type VoiceCommand } from '../lib/speech-recognition.js';
import { sendEvent } from '../lib/ws-client.js';

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

    recognizer.onCommand = (command) => {
      COMMAND_TO_EVENT[command]?.();
    };

    recognizer.onQuestion = (question) => {
      sendEvent({ type: 'command:ask', payload: { question } });
    };

    return () => {
      recognizer.stop();
    };
  }, []);

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

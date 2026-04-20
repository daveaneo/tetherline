import { useEffect, useRef, useCallback, useState } from 'react';
import { VoiceCommandRecognizer, type VoiceCommand } from '../lib/speech-recognition.js';
import { AudioCapture } from '../lib/audio-capture.js';
import { sendEvent } from '../lib/ws-client.js';
import { useSessionStore } from '../state/session-store.js';
import { useAudioStore } from '../state/audio-store.js';
import { API_PREFIX } from '@tetherline/shared';

const COMMAND_PHRASES: Record<string, VoiceCommand> = {
  'next': 'next', 'move on': 'next', 'continue': 'next',
  'go back': 'previous', 'previous': 'previous', 'back': 'previous',
  'dive deeper': 'dive_deeper', 'more detail': 'dive_deeper', 'tell me more': 'dive_deeper',
  'skip': 'skip', 'skip this': 'skip',
  'pause': 'pause', 'stop': 'pause',
  'resume': 'resume', 'go': 'resume', 'play': 'resume',
  'show concerns': 'show_concerns', 'concerns': 'show_concerns',
  // Export commands
  'export slides': 'export_slides', 'make slides': 'export_slides', 'create a presentation': 'export_slides',
  'export markdown': 'export_markdown', 'make a summary': 'export_markdown', 'write it up': 'export_markdown',
  // Mode toggle commands
  'turn on narration': 'toggle_narration_on', 'unmute': 'toggle_narration_on',
  'turn off narration': 'toggle_narration_off', 'mute': 'toggle_narration_off',
  'turn on advisory': 'toggle_advisory_on', 'show issues': 'toggle_advisory_on',
  'turn off advisory': 'toggle_advisory_off', 'hide concerns': 'toggle_advisory_off',
  'turn on active learning': 'toggle_activeLearning_on',
  'turn off active learning': 'toggle_activeLearning_off',
  'turn on alerts': 'toggle_alerts_on',
  'turn off alerts': 'toggle_alerts_off',
  // Exit / back to lobby
  'exit': 'exit_session', 'go home': 'exit_session', 'back to lobby': 'exit_session', 'quit': 'exit_session',
};

const COMMAND_TO_EVENT: Record<VoiceCommand, () => void> = {
  next: () => sendEvent({ type: 'command:next' }),
  previous: () => sendEvent({ type: 'command:previous' }),
  dive_deeper: () => sendEvent({ type: 'command:dive_deeper' }),
  skip: () => sendEvent({ type: 'command:skip' }),
  pause: () => sendEvent({ type: 'command:pause' }),
  resume: () => sendEvent({ type: 'command:resume' }),
  show_concerns: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'advisory', enabled: true } }),
  // Export commands
  export_slides: () => sendEvent({ type: 'command:export', payload: { format: 'slides' } }),
  export_markdown: () => sendEvent({ type: 'command:export', payload: { format: 'markdown' } }),
  // Mode toggle commands
  toggle_narration_on: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'narration', enabled: true } }),
  toggle_narration_off: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'narration', enabled: false } }),
  toggle_advisory_on: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'advisory', enabled: true } }),
  toggle_advisory_off: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'advisory', enabled: false } }),
  toggle_activeLearning_on: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'activeLearning', enabled: true } }),
  toggle_activeLearning_off: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'activeLearning', enabled: false } }),
  toggle_alerts_on: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'alerts', enabled: true } }),
  toggle_alerts_off: () => sendEvent({ type: 'command:toggle_mode', payload: { mode: 'alerts', enabled: false } }),
  // Exit / back to lobby
  exit_session: () => {
    sendEvent({ type: 'command:pause' });
    useSessionStore.getState().resetSession();
  },
};

function matchCommand(text: string): VoiceCommand | null {
  const lower = text.toLowerCase().trim();
  for (const [phrase, command] of Object.entries(COMMAND_PHRASES)) {
    if (lower === phrase || lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase)) {
      return command;
    }
  }
  return null;
}

function handleTranscript(text: string) {
  const audioStore = useAudioStore.getState();
  audioStore.addSpeechToast(text);

  // Record in conversation history
  useSessionStore.getState().addConversation('you', text);

  // Check for navigation commands
  const command = matchCommand(text);
  if (command) {
    audioStore.setVoiceState('processing');
    COMMAND_TO_EVENT[command]?.();
    setTimeout(() => {
      if (useAudioStore.getState().voiceState === 'processing') {
        useAudioStore.getState().setVoiceState('listening');
      }
    }, 500);
    return;
  }

  // Send as utterance for AI classification
  audioStore.setVoiceState('processing');
  sendEvent({ type: 'user:utterance', payload: { text, timestamp: Date.now() } });
}

export function useVoiceInput() {
  const recognizerRef = useRef<VoiceCommandRecognizer | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [mode, setMode] = useState<'whisper' | 'browser' | 'none'>('none');

  // Check which STT backend is available
  useEffect(() => {
    fetch(`${API_PREFIX}/audio/status`)
      .then(r => r.json())
      .then((data: any) => {
        if (data.whisper) {
          setMode('whisper');
          setSupported(true);
        } else {
          // Fall back to Web Speech API
          const recognizer = new VoiceCommandRecognizer();
          if (recognizer.isSupported()) {
            recognizerRef.current = recognizer;
            setMode('browser');
            setSupported(true);
            wireWebSpeechCallbacks(recognizer);
          }
        }
      })
      .catch(() => {
        // Sidecar not running — try Web Speech API
        const recognizer = new VoiceCommandRecognizer();
        if (recognizer.isSupported()) {
          recognizerRef.current = recognizer;
          setMode('browser');
          setSupported(true);
          wireWebSpeechCallbacks(recognizer);
        }
      });

    return () => {
      recognizerRef.current?.stop();
      captureRef.current?.stop();
    };
  }, []);

  // Register startListening with the audio store
  const startListening = useCallback(() => {
    if (listening) {
      useAudioStore.getState().addSpeechToast('[Mic: already listening]');
      return;
    }

    if (mode === 'whisper') {
      // Use AudioCapture with echo cancellation + Whisper
      const capture = new AudioCapture({
        onSpeechStart: () => {
          const audioStore = useAudioStore.getState();
          audioStore.setVoiceState('hearing');
          if (audioStore.isPlaying) {
            sendEvent({ type: 'command:pause' });
          }
        },
        onSpeechEnd: () => {
          const audioStore = useAudioStore.getState();
          if (audioStore.voiceState === 'hearing') {
            audioStore.setVoiceState('processing');
          }
        },
        onTranscript: (text) => {
          handleTranscript(text);
        },
        onError: (error) => {
          useAudioStore.getState().addSpeechToast(`[${error}]`);
        },
        onStateChange: (state) => {
          useAudioStore.getState().addSpeechToast(`[${state}]`);
        },
      });
      capture.start();
      captureRef.current = capture;
      setListening(true);
      useAudioStore.getState().addSpeechToast('[Mic: started (Whisper + echo cancellation)]');

    } else if (mode === 'browser') {
      // Fall back to Web Speech API
      try {
        recognizerRef.current?.start();
        setListening(true);
        useAudioStore.getState().addSpeechToast('[Mic: started (Web Speech)]');
      } catch (err: any) {
        useAudioStore.getState().addSpeechToast(`[Mic error: ${err.message}]`);
      }
    } else {
      useAudioStore.getState().addSpeechToast('[Mic: not available]');
    }
  }, [listening, mode]);

  useEffect(() => {
    useAudioStore.getState().setStartMicFn(startListening);
  }, [startListening]);

  // Auto-stop when returning to IDLE
  const phase = useSessionStore(s => s.state.phase);
  useEffect(() => {
    if (phase === 'IDLE' && listening) {
      captureRef.current?.stop();
      captureRef.current = null;
      recognizerRef.current?.stop();
      setListening(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const toggleListening = useCallback(() => {
    if (listening) {
      captureRef.current?.stop();
      captureRef.current = null;
      recognizerRef.current?.stop();
      setListening(false);
    } else {
      startListening();
    }
  }, [listening, startListening]);

  return { listening, toggleListening, startListening, supported, mode };
}

/** Wire callbacks for the Web Speech API fallback */
function wireWebSpeechCallbacks(recognizer: VoiceCommandRecognizer) {
  recognizer.onSpeechStart = () => {
    const audioStore = useAudioStore.getState();
    audioStore.setVoiceState('hearing');
    audioStore.addSpeechToast('[hearing...]');
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
      if (useAudioStore.getState().voiceState === 'processing') {
        useAudioStore.getState().setVoiceState('listening');
      }
    }, 500);
  };

  recognizer.onUtterance = (text) => {
    handleTranscript(text);
  };

  recognizer.onError = (error) => {
    useAudioStore.getState().addSpeechToast(`[Mic error: ${error}]`);
  };

  recognizer.onStateChange = (state) => {
    useAudioStore.getState().addSpeechToast(`[${state}]`);
  };
}

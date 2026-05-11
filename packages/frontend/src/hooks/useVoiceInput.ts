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

/** Whisper hallucinates fixed phrases when fed silence or background noise.
 *  These phrases are NOT what the user said — dropping them prevents the
 *  "I'm here and ready to help!" filler reply storm during quiet moments. */
const WHISPER_HALLUCINATIONS = new Set([
  'you', '.', 'thanks for watching', 'thanks for watching!',
  'thank you', 'thank you.', 'thank you!', 'thanks', 'thanks.',
  'bye', 'bye.', 'bye!', 'goodbye', 'goodbye.',
  'subscribe', 'please subscribe', 'subscribe!',
  'silence', '[silence]', 'background noise', '[music]',
  'um', 'uh', 'mm', 'mhm', 'hm', 'oh',
]);

function isLikelyNoiseArtifact(text: string): boolean {
  const cleaned = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (cleaned.length < 3) return true;
  if (WHISPER_HALLUCINATIONS.has(cleaned)) return true;
  // Single-word transcripts that aren't navigation phrases are usually noise.
  // Real user utterances during a code review are almost always >1 word.
  if (!/\s/.test(cleaned) && cleaned.length < 6) return true;
  return false;
}

/** Echo-gate window in ms. Whisper buffers ~1s of audio before transcribing,
 *  and speakers can reverb for several hundred ms after playback ends, so
 *  the most common echo case is a transcript that arrives just after
 *  isPlaying flips false. Suppress anything within ECHO_GATE_MS of TTS end. */
const ECHO_GATE_MS = 1500;

function handleTranscript(text: string) {
  // Drop transcripts that arrived while the AI was speaking — those are
  // echo from speakers bleeding into the mic, not a user utterance.
  // Without this guard the AI would "hear" itself and trigger another
  // Q&A round, producing the self-interrupt loop the user reported.
  // PTT (hold space) is the explicit way to talk over the AI.
  const audio = useAudioStore.getState();
  if (audio.isPlaying) return;
  if (audio.lastTtsEndAt && Date.now() - audio.lastTtsEndAt < ECHO_GATE_MS) {
    // Echo-gate: speakers may still be reverberating or Whisper may be
    // flushing a buffer that includes the tail of the AI's TTS. Drop.
    return;
  }

  // Check for navigation commands FIRST so legitimate single-word commands
  // like "next" / "skip" / "pause" aren't mistaken for noise.
  const command = matchCommand(text);

  if (!command && isLikelyNoiseArtifact(text)) {
    // Drop silently — don't even toast. The user didn't speak; we shouldn't
    // pretend they did or generate a filler reply.
    return;
  }

  const audioStore = useAudioStore.getState();
  audioStore.addSpeechToast(text);

  // Record in conversation history
  useSessionStore.getState().addConversation('you', text);

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

  // Failsafe: if voiceState is still 'processing' after 10 seconds with no
  // response, drop back to 'listening' so the user isn't stuck staring at
  // a "Thinking..." overlay indefinitely when the pipeline hangs.
  setTimeout(() => {
    const s = useAudioStore.getState();
    if (s.voiceState === 'processing') {
      s.addSpeechToast('[no response — releasing mic]');
      s.setVoiceState('listening');
    }
  }, 10_000);
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

  // When start() hasn't resolved yet but the user already released space,
  // we need to wait before calling stop() — otherwise we kill the capture
  // before it ever ran. PTT keyup awaits this ref to avoid that race.
  const captureStartPromiseRef = useRef<Promise<void> | null>(null);

  // Register startListening with the audio store
  const startListening = useCallback(() => {
    if (listening) {
      useAudioStore.getState().addSpeechToast('[Mic: already listening]');
      return;
    }

    if (mode === 'whisper') {
      // Use AudioCapture with echo cancellation + Whisper.
      // Voice barge-in is INTENTIONALLY disabled — the AI's own audio
      // bleeds into the mic and triggers self-interrupt. Push-to-talk
      // (hold space) is the deliberate interrupt gesture; see the PTT
      // useEffect above.
      const capture = new AudioCapture({
        onSpeechStart: () => {
          // UI-only feedback: orb shows we're hearing something. We do
          // NOT flush AI playback or signal speaking_started — that path
          // belongs to PTT now.
          useAudioStore.getState().setVoiceState('hearing');
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
      // Capture mic permission + AudioContext setup is async (~100ms). Stash
      // the promise so PTT keyup can wait for it — otherwise a fast tap
      // (down + up within 50ms) tears down the capture before it ever ran,
      // producing the "no transcript ever arrived" failure mode.
      captureStartPromiseRef.current = capture.start().catch(err => {
        useAudioStore.getState().addSpeechToast(`[Mic start failed: ${err.message ?? err}]`);
      });
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

  // Mirror `listening` into the audio store so the chrome MicToggle can
  // render the right state without needing this hook. Also register a
  // stop function so the toggle can turn the mic off.
  useEffect(() => {
    useAudioStore.getState().setMicListening(listening);
  }, [listening]);
  const stopListening = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    recognizerRef.current?.stop();
    setListening(false);
    if (useAudioStore.getState().voiceState === 'hearing') {
      useAudioStore.getState().setVoiceState('idle');
    }
  }, []);
  useEffect(() => {
    useAudioStore.getState().setStopMicFn(stopListening);
  }, [stopListening]);

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

  // ─── Push-to-talk (hold space) ──────────────────────────────────────
  // Hold spacebar → mic hot, AI speech aborted, backend told user is
  // speaking. Release → mic off (if it wasn't on before), backend told
  // user stopped. A SHORT tap (< HOLD_THRESHOLD_MS) instead toggles
  // pause/resume so the existing keyboard muscle memory still works.
  //
  // Hold/tap state lives in refs so that calling `startListening()` (which
  // triggers `setListening(true)` and re-runs this effect's deps) doesn't
  // wipe `holdActive` mid-hold. Without this, the keyup that follows a
  // genuine hold is misclassified as a tap and pause/resume fires.
  const ptHoldActiveRef = useRef(false);
  const ptMicWasListeningRef = useRef(false);
  const listeningRef = useRef(listening);
  useEffect(() => { listeningRef.current = listening; }, [listening]);

  useEffect(() => {
    // Spacebar is now PURE hold-to-talk. No tap-as-pause anymore — that
    // disambiguation was confusing (user reported: "I thought space was
    // for the mic"). Pause/resume lives on a button click, not a key.
    const isTypingTarget = (t: EventTarget | null): boolean => {
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true;
      if (t instanceof HTMLElement && t.isContentEditable) return true;
      return false;
    };

    const onKeyDown = async (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (e.repeat) { e.preventDefault(); return; }
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      const phaseNow = useSessionStore.getState().state.phase;
      if (phaseNow === 'IDLE') return;
      if (ptHoldActiveRef.current) return;
      ptHoldActiveRef.current = true;
      const audioStore = useAudioStore.getState();
      ptMicWasListeningRef.current = listeningRef.current;
      audioStore.setVoiceState('hearing');
      audioStore.flushOnInterrupt();
      // Reset the post-TTS echo gate: the user is now deliberately
      // speaking, so suppressing their transcript because TTS ended
      // recently would be wrong. The gate exists for AMBIENT echo, not
      // intentional PTT speech.
      useAudioStore.setState({ lastTtsEndAt: 0 });
      sendEvent({ type: 'user:speaking_started' });
      if (!listeningRef.current) startListening();
      // Wait for capture.start() to fully resolve, then explicitly mark
      // the speech boundary. Without this, the VAD-driven flow only
      // ships audio to Whisper when it detects silence-after-confirmed-
      // speech — for short PTT holds, VAD never confirms and the audio
      // buffer is trimmed before transcription. Explicit start/end
      // bypasses the VAD state machine entirely.
      await captureStartPromiseRef.current;
      captureRef.current?.forceSpeechStart();
    };

    const onKeyUp = async (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (!ptHoldActiveRef.current) return;
      ptHoldActiveRef.current = false;
      sendEvent({ type: 'user:speaking_stopped' });
      // Wait for the start to complete (race with fast taps), then close
      // the PTT recording window — this triggers the Whisper POST and
      // surfaces the transcript via the onTranscript callback. Awaiting
      // here ensures the capture isn't torn down before transcription
      // finishes.
      await captureStartPromiseRef.current;
      await captureRef.current?.forceSpeechEnd();
      // If we turned the mic on for this hold only, turn it back off so
      // ambient sound never reaches the AI. The toggle (chrome button)
      // is the only way to leave the mic continuously hot.
      if (!ptMicWasListeningRef.current) {
        captureRef.current?.stop();
        captureRef.current = null;
        recognizerRef.current?.stop();
        setListening(false);
        // We just stopped the mic, so the orb should NOT claim it's
        // listening. Drop to 'idle' so the UI matches reality.
        if (useAudioStore.getState().voiceState === 'hearing') {
          useAudioStore.getState().setVoiceState('idle');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startListening]);

  // Pause = full mic stop. Resume restarts the mic iff it was listening
  // before the pause. `wasListeningBeforePauseRef` remembers that intent so
  // the user doesn't have to click Unmute after every pause/resume cycle.
  const paused = useSessionStore(s => s.state.paused);
  const wasListeningBeforePauseRef = useRef(false);
  useEffect(() => {
    if (paused) {
      if (listening) {
        wasListeningBeforePauseRef.current = true;
        captureRef.current?.stop();
        captureRef.current = null;
        recognizerRef.current?.stop();
        setListening(false);
        useAudioStore.getState().addSpeechToast('[Mic: paused]');
      }
    } else if (wasListeningBeforePauseRef.current) {
      wasListeningBeforePauseRef.current = false;
      startListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

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
  // Voice barge-in is disabled — see the AudioCapture branch above for the
  // rationale. Hold space to interrupt the AI; the recognizer here is only
  // for transcribing what the user actually says.
  recognizer.onSpeechStart = () => {
    const audioStore = useAudioStore.getState();
    audioStore.setVoiceState('hearing');
    audioStore.addSpeechToast('[hearing...]');
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

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

/** Echo-gate windows in ms. Two signals to gate on:
 *
 *  TTS_END_GATE_MS — speakers reverb / Whisper buffer after isPlaying
 *  flips false. Short window (1.5s) post-playback-end.
 *
 *  NARRATION_GATE_MS — covers the time between when a narration EVENT
 *  arrives and when its TTS audio finishes. The synchronous
 *  narration:greeting path can play 5-10+ seconds of audio without
 *  ever updating isPlaying / lastTtsEndAt (it goes through
 *  speechSynthesis or a separate audio element). Without this
 *  longer gate, the AI's own playback gets transcribed mid-stream
 *  ("carries your knowledge" → "parries your knowledge"), triggering
 *  another round of replies and a self-interrupt loop. */
const TTS_END_GATE_MS = 1500;
const NARRATION_GATE_MS = 12_000;

/** PTT keyup sets this — the transcript arriving from that hold is an
 *  EXPLICIT user gesture, so it bypasses the self-echo content match
 *  (the user may legitimately repeat words the AI just spoke, e.g. a
 *  suggested command phrase). Cleared on first use / timeout. */
let expectPttTranscriptUntil = 0;
export function markPttTranscriptExpected(): void {
  expectPttTranscriptUntil = Date.now() + 5000;
}

function handleTranscript(text: string) {
  const audio = useAudioStore.getState();
  const viaPtt = Date.now() < expectPttTranscriptUntil;
  if (viaPtt) expectPttTranscriptUntil = 0;
  // Gated speech is logged GREYED in the conversation log rather than
  // silently eaten — the user can see "I heard you but ignored it (echo
  // gate); hold Space to talk over me." No toast (real echo would spam).
  const dropGated = () => {
    if (!isLikelyNoiseArtifact(text)) {
      useSessionStore.getState().addConversation('you', text, { muted: true });
    }
  };
  /** This speech episode produced nothing actionable: resume any ducked
   *  playback and tell the backend the floor is free again. */
  const resolveDiscarded = () => {
    if (audio.userHasFloor) {
      audio.resumeFromFloor('noise');
      sendEvent({ type: 'user:speaking_stopped' });
    }
  };

  // Self-echo content match runs FIRST — authoritative regardless of any
  // timing window. The live bug: the AI spoke 'say "back to the tour"',
  // the mic transcribed its own words 12s later (just past the narration
  // gate) and EXECUTED the command. Content matching catches what timing
  // gates structurally cannot. PTT bypasses (explicit gesture).
  if (!viaPtt && audio.matchesRecentSpokenText(text)) {
    dropGated();
    resolveDiscarded();
    return;
  }

  if (!audio.userHasFloor && !viaPtt) {
    // No floor episode (e.g. Web Speech without VAD wiring, or stale
    // transcripts): the classic time gates apply. When the floor IS held,
    // the VAD already confirmed this as user speech — the time gates
    // would eat a legitimate barge-in (PTT bypasses them the same way).
    if (audio.isPlaying) { dropGated(); return; }
    if (audio.lastTtsEndAt && Date.now() - audio.lastTtsEndAt < TTS_END_GATE_MS) {
      // Echo-gate: speakers may still be reverberating or Whisper may be
      // flushing a buffer that includes the tail of the AI's TTS. Drop.
      dropGated();
      return;
    }
    if (audio.lastNarrationAt && Date.now() - audio.lastNarrationAt < NARRATION_GATE_MS) {
      // Stronger gate: a narration event recently arrived; its audio
      // is likely still playing even if isPlaying says otherwise.
      dropGated();
      return;
    }
  }

  // Check for navigation commands FIRST so legitimate single-word commands
  // like "next" / "skip" / "pause" aren't mistaken for noise.
  const command = matchCommand(text);

  if (!command && isLikelyNoiseArtifact(text)) {
    // Drop silently — don't even toast. The user didn't speak; we shouldn't
    // pretend they did or generate a filler reply.
    resolveDiscarded();
    return;
  }

  // Real user speech survived every gate. If it arrived via a floor
  // episode, finish the barge-in: hard-flush the interrupted answer
  // (stale by definition — the user talked over it) and keep the floor
  // closed until this turn's response starts streaming.
  if (audio.userHasFloor) {
    audio.claimFloorForUtterance();
    sendEvent({ type: 'user:speaking_stopped' });
  }

  const audioStore = useAudioStore.getState();
  audioStore.addSpeechToast(text);

  // Record in conversation history
  useSessionStore.getState().addConversation('you', text);

  if (command) {
    audioStore.setVoiceState('processing');
    COMMAND_TO_EVENT[command]?.();
    // Commands act instantly and produce no response stream — release the
    // floor now or the drain loop would stay frozen until the failsafe.
    useAudioStore.getState().releaseFloor();
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

  // Failsafe: if voiceState is still 'processing' after 15 seconds with no
  // response, drop back to 'listening' so the user isn't stuck staring at
  // a "thinking" overlay indefinitely when the pipeline hangs. Also reopens
  // the floor — a dead pipeline must never leave the AI mute forever (floor
  // deadlock = permanent silence). 15s (not 10) so the visualize live-author
  // path (~12s) finishes before the escape hatch trips and reopens the mic.
  setTimeout(() => {
    const s = useAudioStore.getState();
    if (s.voiceState === 'processing') {
      s.addSpeechToast('No response — releasing mic', 'status');
      s.setVoiceState('listening');
    }
    if (s.userHasFloor && s.floorPhase === 'awaiting-response') {
      s.releaseFloor();
    }
  }, 15_000);
}

export function useVoiceInput() {
  const recognizerRef = useRef<VoiceCommandRecognizer | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const [mode, setMode] = useState<'whisper' | 'browser' | 'none'>('none');

  // Shared status-probe — used both on mount AND on demand (PTT keydown
  // calls it when mode === 'none' to recover from a stale negative
  // mount-time result, e.g. when the sidecar comes online AFTER page
  // load). Returns the resolved mode so callers can branch on success.
  const probeAudioStatus = useCallback(async (): Promise<'whisper' | 'browser' | 'none'> => {
    try {
      const r = await fetch(`${API_PREFIX}/audio/status`);
      const data: any = await r.json();
      if (data.whisper) {
        setMode('whisper');
        setSupported(true);
        return 'whisper';
      }
    } catch {
      // fall through to browser fallback
    }
    const recognizer = new VoiceCommandRecognizer();
    if (recognizer.isSupported()) {
      recognizerRef.current = recognizer;
      setMode('browser');
      setSupported(true);
      wireWebSpeechCallbacks(recognizer);
      return 'browser';
    }
    setMode('none');
    return 'none';
  }, []);

  // Check which STT backend is available on mount.
  useEffect(() => {
    void probeAudioStatus();
    return () => {
      recognizerRef.current?.stop();
      captureRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When start() hasn't resolved yet but the user already released space,
  // we need to wait before calling stop() — otherwise we kill the capture
  // before it ever ran. PTT keyup awaits this ref to avoid that race.
  const captureStartPromiseRef = useRef<Promise<void> | null>(null);

  // Register startListening with the audio store
  const startListening = useCallback(async () => {
    if (listening) {
      useAudioStore.getState().addSpeechToast('Mic: already listening', 'status');
      return;
    }

    // Stale-negative recovery: if mount-time probe timed out (e.g. the
    // sidecar booted but its first /health call was slow), mode would
    // stick at 'none' and PTT would silently drop everything. Re-probe
    // on every actual mic-start so the user recovers once the backend
    // becomes reachable, without having to refresh the page.
    let effectiveMode = mode;
    if (effectiveMode === 'none') {
      effectiveMode = await probeAudioStatus();
    }

    if (effectiveMode === 'whisper') {
      // Use AudioCapture with echo cancellation + Whisper.
      // Floor protocol (duck-and-confirm): the capture layer soft-pauses
      // AI playback at sound-detect and confirms the floor at the 100ms
      // VAD confirm. Real speech then hard-flushes in handleTranscript;
      // noise/echo resumes playback from the pause point. The OLD
      // destructive barge-in (hard-kill at sound-detect, no recovery)
      // is gone; PTT remains the explicit always-works override.
      const capture = new AudioCapture({
        onSpeechStart: () => {
          // VAD confirmed speech: orb feedback + tell the backend the
          // user holds the floor (it holds this turn's chunks instead
          // of dropping them, and stops talking over the user).
          useAudioStore.getState().setVoiceState('hearing');
          sendEvent({ type: 'user:speaking_started' });
        },
        onSpeechEnd: () => {
          const audioStore = useAudioStore.getState();
          if (audioStore.voiceState === 'hearing') {
            audioStore.setVoiceState('processing');
          }
          // NOTE: user:speaking_stopped is deliberately NOT sent here —
          // Whisper hasn't transcribed yet. The episode resolves in
          // handleTranscript (utterance/command sent) or onSpeechDiscarded.
        },
        onTranscript: (text) => {
          handleTranscript(text);
        },
        onSpeechDiscarded: () => {
          // The episode produced no usable transcript — the duck was a
          // false alarm. Resume playback and free the backend floor.
          const a = useAudioStore.getState();
          if (a.userHasFloor) {
            a.resumeFromFloor('noise');
            sendEvent({ type: 'user:speaking_stopped' });
          }
          if (a.voiceState === 'processing') a.setVoiceState('listening');
        },
        onError: (error) => {
          useAudioStore.getState().addSpeechToast(`${error}`, 'error');
        },
        onStateChange: (state) => {
          useAudioStore.getState().addSpeechToast(`${state}`, 'status');
        },
      });
      // Capture mic permission + AudioContext setup is async (~100ms). Stash
      // the promise so PTT keyup can wait for it — otherwise a fast tap
      // (down + up within 50ms) tears down the capture before it ever ran,
      // producing the "no transcript ever arrived" failure mode.
      captureStartPromiseRef.current = capture.start().catch(err => {
        // Permission denied / no device: tear the failed capture down and
        // flip listening back OFF. setListening(true) below runs first
        // (synchronously), so without this the toggle showed a green
        // "Mic on" while nothing was being captured.
        useAudioStore.getState().addSpeechToast(`Mic start failed: ${err.message ?? err}`, 'error');
        capture.stop();
        if (captureRef.current === capture) captureRef.current = null;
        setListening(false);
      });
      captureRef.current = capture;
      setListening(true);
      useAudioStore.getState().addSpeechToast('Mic started (Whisper + echo cancellation)', 'status');

    } else if (effectiveMode === 'browser') {
      // Fall back to Web Speech API
      try {
        recognizerRef.current?.start();
        setListening(true);
        useAudioStore.getState().addSpeechToast('Mic started (Web Speech)', 'status');
      } catch (err: any) {
        useAudioStore.getState().addSpeechToast(`Mic error: ${err.message}`, 'error');
      }
    } else {
      // Actionable failure message — bare "[Mic: not available]"
      // didn't tell the user WHY or HOW to fix. Two common causes:
      // (a) Whisper sidecar isn't running, (b) browser doesn't support
      // Web Speech API (Firefox/Safari). Toast surfaces both fix paths
      // so the user can self-serve without grepping the codebase.
      const store = useAudioStore.getState();
      store.addSpeechToast('Voice input unavailable — see top banner for fix', 'error');
      store.addSpeechToast('Run: python3 packages/backend/src/tts/audio-server.py', 'status');
      store.addSpeechToast('Or open the app in Chrome/Edge (Web Speech API)', 'status');
    }
  }, [listening, mode, probeAudioStatus]);

  // Mirror `mode` into the audio store so MicToggle / banners can
  // show an honest "unavailable" state instead of pretending the
  // mic is just off. Source of truth is still useVoiceInput.
  useEffect(() => {
    useAudioStore.getState().setVoiceMode(mode);
  }, [mode]);

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

  // Floor watchdog: a held floor that never resolves (VAD confirmed but
  // Whisper hung, lost callbacks, tab refocus weirdness) must not mute the
  // AI forever. 8s without resolution → resume + free the backend floor.
  // ('awaiting-response' is excluded — the 10s processing failsafe owns it.)
  useEffect(() => {
    const iv = setInterval(() => {
      const a = useAudioStore.getState();
      if (
        a.userHasFloor &&
        a.floorHeldSince !== null &&
        a.floorPhase !== 'awaiting-response' &&
        Date.now() - a.floorHeldSince > 8000
      ) {
        a.resumeFromFloor('timeout');
        sendEvent({ type: 'user:speaking_stopped' });
      }
    }, 1000);
    return () => clearInterval(iv);
  }, []);

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
      // Reset BOTH echo-gate signals: the user is now deliberately
      // speaking, so suppressing their transcript because TTS ended
      // recently / a narration was just emitted would be wrong. The
      // gates exist for AMBIENT echo, not intentional PTT speech.
      useAudioStore.setState({ lastTtsEndAt: 0, lastNarrationAt: 0 });
      // Mark the start of the hold so the listening pill knows when to
      // render and how long the user has been pressing. Cleared in keyup.
      audioStore.setPttHoldStartedAt(Date.now());
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
      useAudioStore.getState().setPttHoldStartedAt(null);
      sendEvent({ type: 'user:speaking_stopped' });
      // The transcript from this hold is an explicit gesture — it must
      // bypass the self-echo content match (the user may deliberately
      // repeat a phrase the AI just suggested).
      markPttTranscriptExpected();
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
        useAudioStore.getState().addSpeechToast('Mic paused', 'status');
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
  // Floor parity with the Whisper path. The browser's speechstart is
  // already a confirmed-speech signal (no RMS/confirm stage), so duck
  // and confirm in one step.
  recognizer.onSpeechStart = () => {
    const audioStore = useAudioStore.getState();
    audioStore.duckForFloor();
    audioStore.confirmFloor();
    sendEvent({ type: 'user:speaking_started' });
    audioStore.setVoiceState('hearing');
    audioStore.addSpeechToast('hearing…', 'status');
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
    // Discard parity: a recognizer error (no-speech, no-match, aborted)
    // means the floor episode resolves with nothing — resume playback.
    const a = useAudioStore.getState();
    if (a.userHasFloor && a.floorPhase !== 'awaiting-response') {
      a.resumeFromFloor('noise');
      sendEvent({ type: 'user:speaking_stopped' });
    }
    useAudioStore.getState().addSpeechToast(`Mic error: ${error}`, 'error');
  };

  recognizer.onStateChange = (state) => {
    useAudioStore.getState().addSpeechToast(`${state}`, 'status');
  };
}

import { create } from 'zustand';
import type { NarrationSegment } from '@tetherline/shared';

/** `idle` means mic off — used while the session is paused so the user sees
 *  a clear "not listening" indicator (and we actually stop the capture). */
export type VoiceState = 'speaking' | 'listening' | 'hearing' | 'processing' | 'idle';

/** What a toast IS decides how it renders: 'transcript' = something the
 *  user said (green "You" quote); 'status' = system state change (mic
 *  started, paused…); 'error' = something failed. Status/errors used to
 *  masquerade as user quotes — "[Mic access failed]" styled as a thing
 *  You said undermines trust in the transcript. */
export type SpeechToastKind = 'transcript' | 'status' | 'error';

export interface SpeechToast {
  id: string;
  text: string;
  timestamp: number;
  kind: SpeechToastKind;
}

/** Lifecycle of the user's conversational floor.
 *  open → nobody is claiming the mic;
 *  provisional → VAD heard sound, playback is ducked, awaiting the 100ms confirm;
 *  confirmed → real speech confirmed, still transcribing;
 *  awaiting-response → a real utterance shipped; floor stays closed until the
 *  turn's response stream starts (or a failsafe releases it). */
export type FloorPhase = 'open' | 'provisional' | 'confirmed' | 'awaiting-response';

interface AudioStore {
  currentSegment: NarrationSegment | null;
  isPlaying: boolean;
  queue: NarrationSegment[];
  voiceState: VoiceState;
  speechToasts: SpeechToast[];

  // Shared audio element — the orchestrator sets this, voice input reads it for instant muting
  audioElement: HTMLAudioElement | null;
  setAudioElement: (el: HTMLAudioElement) => void;
  muteOutput: () => void;
  unmuteOutput: () => void;
  flushOnInterrupt: () => void;

  // ── Conversational floor (the AI must NEVER talk over the user) ──
  /** True from the moment speech is detected until the floor is released.
   *  While held, the orchestrator must not START any new TTS clip. */
  userHasFloor: boolean;
  floorPhase: FloorPhase;
  /** Audio element is soft-paused at its position (resumable — distinct from
   *  the destructive flushOnInterrupt stop). */
  floorPaused: boolean;
  floorHeldSince: number | null;
  /** Bumped by flushOnInterrupt. The orchestrator aborts its in-flight speak
   *  promise on change — a hard-stopped element doesn't reliably fire
   *  `ended`, which used to leave the serialized speech tail pending. */
  flushEpoch: number;
  /** VAD heard sound while the AI may be speaking: soft-pause playback and
   *  take the floor provisionally. Resumable; does NOT touch isPlaying. */
  duckForFloor: () => void;
  /** Provisional → confirmed (VAD 100ms confirm / Web Speech speechstart). */
  confirmFloor: () => void;
  /** The sound wasn't real user speech (no transcript / echo / noise):
   *  resume playback from the pause point and reopen the floor. */
  resumeFromFloor: (reason: 'noise' | 'timeout') => void;
  /** A transcript survived all gates — this is real user speech. Hard-flush
   *  playback; floor stays closed until the turn's response starts. */
  claimFloorForUtterance: () => void;
  /** Fully reopen the floor (response started / failsafe / error). */
  releaseFloor: () => void;

  // ── Self-echo suppression (content-based) ──
  /** Ring buffer of text the AI recently spoke. Transcripts that match are
   *  the mic hearing our own speaker output — never user speech. Timing
   *  gates alone can't catch echo that lands just past their windows (live
   *  bug: the AI spoke "say 'back to the tour'", transcribed itself 12s
   *  later, and executed the command). */
  recentSpokenText: Array<{ text: string; at: number }>;
  recordSpokenText: (text: string) => void;
  matchesRecentSpokenText: (transcript: string) => boolean;

  // Interrupt backoff — prevents AI from speaking immediately after being interrupted
  interruptBackoffUntil: number;
  setInterruptBackoff: (until: number) => void;
  isInBackoff: () => boolean;

  /** Timestamp when TTS playback last finished. Used as an echo-gate:
   *  mic transcripts arriving within ~1.5s of TTS end are suppressed
   *  because they're almost always speaker-bleed of the AI's own audio,
   *  not the user speaking. */
  lastTtsEndAt: number;

  /** Timestamp when ANY narration event (greeting / briefing / stream
   *  chunk) most recently arrived. Stronger echo-gate signal than
   *  lastTtsEndAt because it doesn't depend on the audio element's
   *  onended firing — the synchronous TTS path (greeting → speak via
   *  speechSynthesis) sometimes doesn't update the audio element at
   *  all, so lastTtsEndAt stays stale and Whisper-mishears slip
   *  through. lastNarrationAt covers ALL paths. */
  lastNarrationAt: number;
  setLastNarrationAt: (t: number) => void;

  // Mic start function — set by useVoiceInput, callable from anywhere (e.g. Lobby click)
  _startMicFn: (() => void) | null;
  setStartMicFn: (fn: () => void) => void;
  requestMicStart: () => void;
  /** Mirrored from useVoiceInput's `listening` state so any component
   *  (e.g. the chrome MicToggle) can read mic on/off without needing
   *  the hook itself. Source of truth still lives in useVoiceInput. */
  micListening: boolean;
  setMicListening: (v: boolean) => void;
  /** Mic stop function — set by useVoiceInput, callable from MicToggle. */
  _stopMicFn: (() => void) | null;
  setStopMicFn: (fn: () => void) => void;
  requestMicStop: () => void;
  /** Which STT backend is wired up. 'none' = nothing works → mic toggle
   *  + PTT should report unavailable with actionable instructions, not
   *  silently fail. Mirrored from useVoiceInput so MicToggle / banners
   *  can read it without depending on the hook. */
  voiceMode: 'whisper' | 'browser' | 'none' | 'unknown';
  setVoiceMode: (m: 'whisper' | 'browser' | 'none' | 'unknown') => void;

  /** Timestamp when the user's current PTT hold began, or null when not
   *  holding. Mirrored from useVoiceInput so a listening pill can render
   *  a live "🎙 Listening · 00:14" elapsed counter without coupling to
   *  the hook. Cleared on PTT release. */
  pttHoldStartedAt: number | null;
  setPttHoldStartedAt: (t: number | null) => void;

  setCurrentSegment: (segment: NarrationSegment | null) => void;
  setPlaying: (playing: boolean) => void;
  setVoiceState: (state: VoiceState) => void;
  addSpeechToast: (text: string, kind?: SpeechToastKind) => void;
  enqueueSegment: (segment: NarrationSegment) => void;
  dequeueSegment: () => NarrationSegment | undefined;
  clearQueue: () => void;
}

/** Lowercase, strip punctuation, collapse whitespace — transcript vs spoken
 *  text comparison must survive Whisper's punctuation/casing choices. */
function normalizeSpeech(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

let toastSeq = 0;

const SPOKEN_TEXT_WINDOW_MS = 20_000;
const SPOKEN_TEXT_MAX_ENTRIES = 10;
/** Below this many normalized chars a substring match is meaningless
 *  ("ok", "next" would false-positive constantly). */
const SELF_ECHO_MIN_CHARS = 6;

export const useAudioStore = create<AudioStore>((set, get) => ({
  currentSegment: null,
  isPlaying: false,
  queue: [],
  // Start in 'idle' — the mic is off by default per the voice-UX
  // principle, and the orb should not lie about its state. Starting in
  // 'listening' made the UI claim the mic was hot while micListening was
  // actually false.
  voiceState: 'idle',
  speechToasts: [],
  audioElement: null,
  interruptBackoffUntil: 0,
  lastTtsEndAt: 0,
  lastNarrationAt: 0,
  _startMicFn: null,
  _stopMicFn: null,
  micListening: false,
  voiceMode: 'unknown',
  pttHoldStartedAt: null,

  userHasFloor: false,
  floorPhase: 'open' as FloorPhase,
  floorPaused: false,
  floorHeldSince: null,
  flushEpoch: 0,
  recentSpokenText: [],

  setAudioElement: (el) => set({ audioElement: el }),
  muteOutput: () => {
    const el = get().audioElement;
    if (el) { el.pause(); el.currentTime = el.duration || 0; } // hard stop, not just volume
    if ('speechSynthesis' in window) speechSynthesis.cancel(); // cancel, not pause — more reliable
  },
  /** Full interrupt flush: hard-stops current playback AND drops the queued
   *  segments so nothing resumes behind the user's back. Called when the
   *  mic goes hot. Does NOT touch voiceState (the caller owns that). */
  flushOnInterrupt: () => {
    const el = get().audioElement;
    if (el) { el.pause(); el.currentTime = el.duration || 0; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    set(s => ({ queue: [], currentSegment: null, isPlaying: false, floorPaused: false, flushEpoch: s.flushEpoch + 1 }));
  },

  duckForFloor: () => {
    const s = get();
    if (s.userHasFloor) return; // idempotent — already ducked/claimed
    if (s.isPlaying) {
      // Soft pause, position preserved. isPlaying deliberately stays true:
      // flipping it would stamp lastTtsEndAt (re-arming the echo gate
      // against the user's REAL transcript) and reset the capture layer's
      // echo calibration mid-episode.
      s.audioElement?.pause();
      if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.pause();
      set({ floorPaused: true, userHasFloor: true, floorPhase: 'provisional', floorHeldSince: Date.now() });
    } else {
      set({ userHasFloor: true, floorPhase: 'provisional', floorHeldSince: Date.now() });
    }
  },
  confirmFloor: () => {
    if (!get().userHasFloor) return;
    set({ floorPhase: 'confirmed' });
  },
  resumeFromFloor: (_reason) => {
    const s = get();
    if (!s.userHasFloor) return;
    if (s.floorPaused) {
      void s.audioElement?.play()?.catch(() => {});
      if ('speechSynthesis' in window && speechSynthesis.paused) speechSynthesis.resume();
    }
    set({ floorPaused: false, userHasFloor: false, floorPhase: 'open', floorHeldSince: null });
  },
  claimFloorForUtterance: () => {
    get().flushOnInterrupt();
    set({ userHasFloor: true, floorPhase: 'awaiting-response', floorPaused: false });
  },
  releaseFloor: () => set({ userHasFloor: false, floorPhase: 'open', floorPaused: false, floorHeldSince: null }),

  recordSpokenText: (text) => {
    const t = text.trim();
    if (!t) return;
    const now = Date.now();
    set(s => ({
      recentSpokenText: [...s.recentSpokenText, { text: t, at: now }]
        .filter(e => now - e.at < SPOKEN_TEXT_WINDOW_MS)
        .slice(-SPOKEN_TEXT_MAX_ENTRIES),
    }));
  },
  matchesRecentSpokenText: (transcript) => {
    const norm = normalizeSpeech(transcript);
    if (norm.length < SELF_ECHO_MIN_CHARS) return false;
    const now = Date.now();
    return get().recentSpokenText.some(e => {
      if (now - e.at >= SPOKEN_TEXT_WINDOW_MS) return false;
      const spoken = normalizeSpeech(e.text);
      // Either containment direction: a short transcript is usually a
      // fragment of the spoken sentence; an over-eager transcript can
      // also swallow a short spoken phrase whole.
      return spoken.includes(norm) || (spoken.length >= SELF_ECHO_MIN_CHARS && norm.includes(spoken));
    });
  },
  unmuteOutput: () => {
    // After a hard stop, we don't resume — the orchestrator will play the next segment
    // This is intentional: interrupt = stop talking, not pause-and-resume
  },

  setInterruptBackoff: (until) => set({ interruptBackoffUntil: until }),
  isInBackoff: () => Date.now() < get().interruptBackoffUntil,

  setStartMicFn: (fn) => set({ _startMicFn: fn }),
  requestMicStart: () => { get()._startMicFn?.(); },
  setStopMicFn: (fn) => set({ _stopMicFn: fn }),
  requestMicStop: () => { get()._stopMicFn?.(); },
  setMicListening: (v) => set({ micListening: v }),
  setVoiceMode: (m) => set({ voiceMode: m }),
  setPttHoldStartedAt: (t) => set({ pttHoldStartedAt: t }),
  setLastNarrationAt: (t) => set({ lastNarrationAt: t }),

  setCurrentSegment: (segment) => set({ currentSegment: segment }),
  setPlaying: (playing) => set((s) => ({
    isPlaying: playing,
    // When TTS finishes, the orb should reflect the actual mic state, not
    // a hardcoded "listening" lie. If the mic is on → 'listening'; else
    // → 'idle'. Same for when TTS starts: only block-state on 'speaking'
    // if we were previously in a non-speaking state.
    voiceState: playing
      ? 'speaking'
      : s.voiceState === 'speaking'
        ? (s.micListening ? 'listening' : 'idle')
        : s.voiceState,
    // Track when TTS ended so the echo gate can suppress mic transcripts
    // that arrive in the speaker-reverb tail (~1.5s after playback ends).
    lastTtsEndAt: !playing && s.isPlaying ? Date.now() : s.lastTtsEndAt,
  })),
  setVoiceState: (voiceState) => set({ voiceState }),

  addSpeechToast: (text, kind = 'transcript') => {
    // Counter suffix: same-ms toasts (the stacked unavailable-fix trio)
    // produced identical ids → duplicate React keys in SpeechToasts.
    const toast: SpeechToast = { id: `toast-${Date.now()}-${toastSeq++}`, text, timestamp: Date.now(), kind };
    set(s => ({ speechToasts: [...s.speechToasts.slice(-4), toast] })); // keep last 5
    // Auto-remove after 4 seconds
    setTimeout(() => {
      set(s => ({ speechToasts: s.speechToasts.filter(t => t.id !== toast.id) }));
    }, 4000);
  },

  enqueueSegment: (segment) => set(s => ({ queue: [...s.queue, segment] })),
  dequeueSegment: () => {
    const queue = get().queue;
    if (queue.length === 0) return undefined;
    const [next, ...rest] = queue;
    set({ queue: rest });
    return next;
  },
  clearQueue: () => set({ queue: [], currentSegment: null, isPlaying: false, voiceState: 'listening', speechToasts: [] }),
}));

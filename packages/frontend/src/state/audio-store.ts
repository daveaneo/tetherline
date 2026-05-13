import { create } from 'zustand';
import type { NarrationSegment } from '@tetherline/shared';

/** `idle` means mic off — used while the session is paused so the user sees
 *  a clear "not listening" indicator (and we actually stop the capture). */
export type VoiceState = 'speaking' | 'listening' | 'hearing' | 'processing' | 'idle';

export interface SpeechToast {
  id: string;
  text: string;
  timestamp: number;
}

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

  // Interrupt backoff — prevents AI from speaking immediately after being interrupted
  interruptBackoffUntil: number;
  setInterruptBackoff: (until: number) => void;
  isInBackoff: () => boolean;

  /** Timestamp when TTS playback last finished. Used as an echo-gate:
   *  mic transcripts arriving within ~1.5s of TTS end are suppressed
   *  because they're almost always speaker-bleed of the AI's own audio,
   *  not the user speaking. */
  lastTtsEndAt: number;

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
  addSpeechToast: (text: string) => void;
  enqueueSegment: (segment: NarrationSegment) => void;
  dequeueSegment: () => NarrationSegment | undefined;
  clearQueue: () => void;
}

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
  _startMicFn: null,
  _stopMicFn: null,
  micListening: false,
  voiceMode: 'unknown',
  pttHoldStartedAt: null,

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
    set({ queue: [], currentSegment: null, isPlaying: false });
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

  addSpeechToast: (text) => {
    const toast: SpeechToast = { id: `toast-${Date.now()}`, text, timestamp: Date.now() };
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

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
  voiceState: 'listening',
  speechToasts: [],
  audioElement: null,
  interruptBackoffUntil: 0,
  _startMicFn: null,
  _stopMicFn: null,
  micListening: false,

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

  setCurrentSegment: (segment) => set({ currentSegment: segment }),
  setPlaying: (playing) => set((s) => ({
    isPlaying: playing,
    voiceState: playing
      ? 'speaking'
      : s.voiceState === 'speaking' ? 'listening' : s.voiceState,
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

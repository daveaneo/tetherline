import { create } from 'zustand';
import type { NarrationSegment } from '@interactive-reviewer/shared';

export type VoiceState = 'speaking' | 'listening' | 'hearing' | 'processing';

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

  // Mic start function — set by useVoiceInput, callable from anywhere (e.g. Lobby click)
  _startMicFn: (() => void) | null;
  setStartMicFn: (fn: () => void) => void;
  requestMicStart: () => void;

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
  _startMicFn: null,

  setAudioElement: (el) => set({ audioElement: el }),
  muteOutput: () => {
    const el = get().audioElement;
    if (el) el.volume = 0;
    if ('speechSynthesis' in window) speechSynthesis.pause();
  },
  unmuteOutput: () => {
    const el = get().audioElement;
    if (el) el.volume = 1;
    if ('speechSynthesis' in window) speechSynthesis.resume();
  },

  setStartMicFn: (fn) => set({ _startMicFn: fn }),
  requestMicStart: () => { get()._startMicFn?.(); },

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

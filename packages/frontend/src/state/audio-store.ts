import { create } from 'zustand';
import type { NarrationSegment } from '@interactive-reviewer/shared';

export type VoiceState = 'speaking' | 'listening' | 'hearing' | 'processing';

interface AudioStore {
  currentSegment: NarrationSegment | null;
  isPlaying: boolean;
  queue: NarrationSegment[];
  voiceState: VoiceState;

  setCurrentSegment: (segment: NarrationSegment | null) => void;
  setPlaying: (playing: boolean) => void;
  setVoiceState: (state: VoiceState) => void;
  enqueueSegment: (segment: NarrationSegment) => void;
  dequeueSegment: () => NarrationSegment | undefined;
  clearQueue: () => void;
}

export const useAudioStore = create<AudioStore>((set, get) => ({
  currentSegment: null,
  isPlaying: false,
  queue: [],
  voiceState: 'listening',

  setCurrentSegment: (segment) => set({ currentSegment: segment }),
  setPlaying: (playing) => set((s) => ({
    isPlaying: playing,
    voiceState: playing
      ? 'speaking'
      : s.voiceState === 'speaking' ? 'listening' : s.voiceState,
  })),
  setVoiceState: (voiceState) => set({ voiceState }),
  enqueueSegment: (segment) => set(s => ({ queue: [...s.queue, segment] })),
  dequeueSegment: () => {
    const queue = get().queue;
    if (queue.length === 0) return undefined;
    const [next, ...rest] = queue;
    set({ queue: rest });
    return next;
  },
  clearQueue: () => set({ queue: [], currentSegment: null, isPlaying: false, voiceState: 'listening' }),
}));

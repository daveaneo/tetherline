import { create } from 'zustand';
import type { NarrationSegment } from '@interactive-reviewer/shared';

interface AudioStore {
  currentSegment: NarrationSegment | null;
  isPlaying: boolean;
  queue: NarrationSegment[];

  setCurrentSegment: (segment: NarrationSegment | null) => void;
  setPlaying: (playing: boolean) => void;
  enqueueSegment: (segment: NarrationSegment) => void;
  dequeueSegment: () => NarrationSegment | undefined;
  clearQueue: () => void;
}

export const useAudioStore = create<AudioStore>((set, get) => ({
  currentSegment: null,
  isPlaying: false,
  queue: [],

  setCurrentSegment: (segment) => set({ currentSegment: segment }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  enqueueSegment: (segment) => set(s => ({ queue: [...s.queue, segment] })),
  dequeueSegment: () => {
    const queue = get().queue;
    if (queue.length === 0) return undefined;
    const [next, ...rest] = queue;
    set({ queue: rest });
    return next;
  },
  clearQueue: () => set({ queue: [], currentSegment: null, isPlaying: false }),
}));

import type { NarrationSegment } from '@interactive-reviewer/shared';
import { TTS_PREFETCH_WINDOW } from '@interactive-reviewer/shared';
import type { TTSProvider } from './provider.js';
import { AudioCache } from './audio-cache.js';

export class AudioPrefetcher {
  private generating = new Set<string>();
  private ready = new Map<string, Buffer>();
  private provider: TTSProvider;
  private cache: AudioCache;
  private voice: string;

  constructor(provider: TTSProvider, cache: AudioCache, voice: string = 'coral') {
    this.provider = provider;
    this.cache = cache;
    this.voice = voice;
  }

  // Start prefetching from the given index
  async prefetchFrom(segments: NarrationSegment[], fromIndex: number): Promise<void> {
    const end = Math.min(fromIndex + TTS_PREFETCH_WINDOW, segments.length);
    const tasks: Promise<void>[] = [];

    for (let i = fromIndex; i < end; i++) {
      const segment = segments[i];
      if (this.ready.has(segment.id) || this.generating.has(segment.id)) continue;
      tasks.push(this.generate(segment));
    }

    await Promise.allSettled(tasks);
  }

  private async generate(segment: NarrationSegment): Promise<void> {
    this.generating.add(segment.id);
    try {
      // Check cache first
      const cached = this.cache.get(segment.text, this.voice);
      if (cached) {
        this.ready.set(segment.id, cached);
        return;
      }

      const audio = await this.provider.generateSpeech(segment.text);
      this.cache.set(segment.text, this.voice, audio);
      this.ready.set(segment.id, audio);
    } finally {
      this.generating.delete(segment.id);
    }
  }

  getAudio(segmentId: string): Buffer | null {
    return this.ready.get(segmentId) ?? null;
  }

  isReady(segmentId: string): boolean {
    return this.ready.has(segmentId);
  }

  clear(): void {
    this.ready.clear();
    this.generating.clear();
  }
}

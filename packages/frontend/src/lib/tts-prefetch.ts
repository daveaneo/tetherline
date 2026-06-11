/** Pipelines TTS synthesis: prefetch sentence N+1's audio while sentence N is
 *  still playing, so the serialized speech queue never stalls on a per-sentence
 *  synthesis round-trip (live 2026-06-11: "speaks a couple sentences then
 *  pauses… seems done but isn't"). The default ttsProvider 'openai' fetches
 *  audio per chunk; without this, each sentence boundary is ~1s of dead air.
 *
 *  Keyed by TEXT: identical text ⇒ identical audio, so reuse across turns is
 *  safe and repeated fixed phrases (acks, hooks) dedupe for free. The fetcher
 *  is injected so this is unit-tested with no network. A prefetch that lands
 *  after clear() is simply garbage-collected; the backend disk cache makes any
 *  spent synthesis reusable on replay, so there's no need to abort in flight.
 */
export class TtsPrefetch {
  private inflight = new Map<string, Promise<Blob | null>>();

  constructor(
    private fetchBlob: (text: string) => Promise<Blob | null>,
    private max = 8,
  ) {}

  /** Begin synthesizing `text` if not already in flight. Idempotent. */
  ensure(text: string): void {
    if (!text || this.inflight.has(text)) return;
    if (this.inflight.size >= this.max) {
      // Drop the oldest (insertion order) to bound memory.
      const oldest = this.inflight.keys().next().value as string | undefined;
      if (oldest !== undefined) this.inflight.delete(oldest);
    }
    // Never throw: a failed synth resolves null so the caller falls back to an
    // on-demand fetch / browser TTS.
    const p = this.fetchBlob(text).catch(() => null);
    this.inflight.set(text, p);
  }

  /** Consume the prefetched audio for `text`, or null if none was started. */
  take(text: string): Promise<Blob | null> | null {
    const p = this.inflight.get(text);
    if (!p) return null;
    this.inflight.delete(text);
    return p;
  }

  /** Drop all references (on flush / pause / unmount). */
  clear(): void {
    this.inflight.clear();
  }
}

/**
 * TtsPrefetch — the pipelining core that lets sentence N+1's audio synthesize
 * while sentence N is still playing, killing the per-sentence synthesis hole
 * (live 2026-06-11: "speaks a couple sentences then pauses… seems done but
 * isn't"). Pure + injectable fetcher so it's tested with ZERO API calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { TtsPrefetch } from '../../packages/frontend/src/lib/tts-prefetch.js';

/** A controllable fake fetcher: each call returns a promise we resolve by hand. */
function deferredFetcher() {
  const calls: string[] = [];
  const resolvers = new Map<string, (b: Blob | null) => void>();
  const fetchBlob = (text: string): Promise<Blob | null> => {
    calls.push(text);
    return new Promise<Blob | null>(res => resolvers.set(text, res));
  };
  const resolve = (text: string, blob: Blob | null) => resolvers.get(text)?.(blob);
  return { fetchBlob, calls, resolve };
}

const blob = (s: string) => new Blob([s]);

describe('TtsPrefetch', () => {
  it('ensure() fetches once and dedupes concurrent same-text calls', () => {
    const f = deferredFetcher();
    const p = new TtsPrefetch(f.fetchBlob);
    p.ensure('hello');
    p.ensure('hello');
    p.ensure('world');
    expect(f.calls).toEqual(['hello', 'world']);
  });

  it('take() returns the in-flight promise and consumes the entry', async () => {
    const f = deferredFetcher();
    const p = new TtsPrefetch(f.fetchBlob);
    p.ensure('a');
    const pending = p.take('a');
    expect(pending).not.toBeNull();
    expect(p.take('a'), 'second take is a miss').toBeNull();
    f.resolve('a', blob('a'));
    expect(await pending).toBeInstanceOf(Blob);
  });

  it('take() on an unfetched text is a miss (null)', () => {
    const p = new TtsPrefetch(deferredFetcher().fetchBlob);
    expect(p.take('never')).toBeNull();
  });

  it('a resolved prefetch is reusable until taken', async () => {
    const f = deferredFetcher();
    const p = new TtsPrefetch(f.fetchBlob);
    p.ensure('x');
    f.resolve('x', blob('x'));
    const got = await p.take('x')!;
    expect(got).toBeInstanceOf(Blob);
    expect(f.calls.filter(c => c === 'x')).toHaveLength(1);
  });

  it('clear() drops entries so a later ensure refetches', () => {
    const f = deferredFetcher();
    const p = new TtsPrefetch(f.fetchBlob);
    p.ensure('a');
    p.clear();
    expect(p.take('a')).toBeNull();
    p.ensure('a');
    expect(f.calls).toEqual(['a', 'a']); // refetched after clear
  });

  it('evicts the oldest entry past the cap', () => {
    const f = deferredFetcher();
    const p = new TtsPrefetch(f.fetchBlob, 2);
    p.ensure('1'); p.ensure('2'); p.ensure('3'); // '1' evicted
    expect(p.take('1')).toBeNull();
    expect(p.take('2')).not.toBeNull();
    expect(p.take('3')).not.toBeNull();
  });

  it('a fetcher rejection resolves to null and never throws', async () => {
    const reject = () => Promise.reject(new Error('synth 500'));
    const p = new TtsPrefetch(reject);
    p.ensure('boom');
    await expect(p.take('boom')!).resolves.toBeNull();
  });
});

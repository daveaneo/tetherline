/**
 * TTS pipelining cadence — the contract that fixes "speaks a couple sentences
 * then pauses… seems done but isn't" (live 2026-06-11). With ttsProvider
 * 'openai', each sentence is a /audio/tts round-trip; without pipelining the
 * queue stalls ~1s on every sentence. This asserts (with ZERO real API calls —
 * fetch + Audio + URL are all stubbed) that sentence N+1 SYNTHESIZES WHILE
 * sentence N is still PLAYING, and the handoff after N ends has no fetch wait.
 *
 * Assertions are on EVENT ORDER (a recorded timeline), not wall-clock ms — so
 * they're deterministic and never flake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSessionOrchestrator } from '../../packages/frontend/src/hooks/useSessionOrchestrator.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import { useSettingsStore } from '../../packages/frontend/src/state/settings-store.js';
import { DEFAULT_MODES, DEFAULT_SETTINGS } from '@tetherline/shared';

vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn() }));

// ── timeline + stubbed network/audio (no real API, no real <audio>) ──
let timeline: string[] = [];
let fetchResolvers: Map<string, () => void>;
const blobToText = new WeakMap<Blob, string>();
const urlToText = new Map<string, string>();
let urlSeq = 0;
let liveAudio: FakeAudio | null = null;

class FakeAudio {
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { liveAudio = this; }
  pause() {}
  play() {
    timeline.push(`playStart:${urlToText.get(this.src) ?? '?'}`);
    return Promise.resolve();
  }
}

/** Resolve the in-flight synthesis for `text` (its audio is now "ready"). */
function resolveFetch(text: string) { fetchResolvers.get(text)?.(); }
/** Fire the current clip's ended handler (audio finished playing). */
function fireEnded(text: string) {
  timeline.push(`ended:${text}`);
  liveAudio?.onended?.();
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

beforeEach(() => {
  timeline = [];
  fetchResolvers = new Map();
  urlToText.clear();
  urlSeq = 0;
  liveAudio = null;

  global.fetch = vi.fn((_url: string, opts: any) => {
    const text = JSON.parse(opts.body).text as string;
    timeline.push(`fetchStart:${text}`);
    return new Promise((resolve) => {
      fetchResolvers.set(text, () => {
        const b = new Blob([text]);
        blobToText.set(b, text);
        resolve({ ok: true, blob: () => Promise.resolve(b) } as any);
      });
    });
  }) as any;

  (global as any).URL.createObjectURL = (b: Blob) => {
    const url = `blob:${urlSeq++}`;
    urlToText.set(url, blobToText.get(b) ?? '?');
    return url;
  };
  (global as any).URL.revokeObjectURL = () => {};
  (window as any).Audio = FakeAudio;

  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, ttsProvider: 'openai' },
    modes: { ...DEFAULT_MODES, narration: true },
    settingsOpen: false,
  });
  useAudioStore.setState({
    ...useAudioStore.getState(),
    voiceState: 'listening', currentSegment: null, speechToasts: [],
    interruptBackoffUntil: 0, audioElement: null, isPlaying: false,
    userHasFloor: false, floorPhase: 'open', floorPaused: false,
    floorHeldSince: null, flushEpoch: 0, recentSpokenText: [],
  });
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
    greeting: null, entryMode: 'explore', areas: [],
    streamChunks: [], streamingFinal: false, currentStreamChunk: null, currentStreamId: null,
  } as any);
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

function pushChunks(texts: string[]) {
  texts.forEach((text, i) => {
    useSessionStore.getState().handleServerEvent({
      type: 'narration:stream_chunk',
      payload: { streamId: 's1', seq: i, text, isFinal: i === texts.length - 1 },
    } as any);
  });
}

const idx = (e: string) => timeline.indexOf(e);

describe('TTS pipelining cadence', () => {
  it('synthesizes sentence 2 WHILE sentence 1 is still playing (no stall)', async () => {
    renderHook(() => useSessionOrchestrator());
    await act(async () => { pushChunks(['one.', 'two.', 'three.']); });
    await flush();

    // The drain prefetched the queued sentences; sentence 1 fetched on demand.
    // Resolve + start sentence 1's playback.
    await act(async () => { resolveFetch('one.'); });
    await flush();

    // Sentence 2's synthesis is already in flight while 1 plays.
    expect(idx('playStart:one.'), 'sentence 1 is playing').toBeGreaterThanOrEqual(0);
    expect(idx('fetchStart:two.'), 'sentence 2 synthesis started during playback 1').toBeGreaterThanOrEqual(0);
    expect(idx('fetchStart:two.'), 'and it started before sentence 1 ends').toBeLessThan(
      idx('playStart:one.') + 999, // (ended:1 not fired yet — it isn't in the timeline)
    );
    expect(timeline).not.toContain('ended:one.');
  });

  it('zero-wait handoff: after sentence 1 ends, sentence 2 plays with no new fetch', async () => {
    renderHook(() => useSessionOrchestrator());
    await act(async () => { pushChunks(['one.', 'two.', 'three.']); });
    await flush();
    await act(async () => { resolveFetch('one.'); });
    await flush();
    // Sentence 2 finished synthesizing during playback 1 (prefetched).
    await act(async () => { resolveFetch('two.'); });
    await flush();

    const fetchTwoCount = timeline.filter(e => e === 'fetchStart:two.').length;
    // Sentence 1 ends → sentence 2 should play from the prefetched blob.
    await act(async () => { fireEnded('one.'); });
    await flush();

    expect(idx('playStart:two.'), 'sentence 2 played after 1 ended').toBeGreaterThan(idx('ended:one.'));
    expect(timeline.filter(e => e === 'fetchStart:two.').length,
      'no SECOND synthesis for sentence 2 at handoff (it was prefetched)').toBe(fetchTwoCount);
    expect(fetchTwoCount, 'sentence 2 was synthesized exactly once, ahead of time').toBe(1);
  });
});

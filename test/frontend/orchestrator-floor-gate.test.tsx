/**
 * Orchestrator floor gating: while the user holds the floor, the drain
 * loop must not consume or speak ANY chunk; release drains in order.
 * scheduleAdvance must never fire command:next mid-floor. flushEpoch
 * (PTT / confirmed barge-in) aborts the in-flight speak and kills the
 * stale unspoken backlog.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSessionOrchestrator } from '../../packages/frontend/src/hooks/useSessionOrchestrator.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import { useSettingsStore } from '../../packages/frontend/src/state/settings-store.js';
import { DEFAULT_MODES, DEFAULT_SETTINGS } from '@tetherline/shared';

const sentEvents: any[] = [];
vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({
  sendEvent: vi.fn((e: any) => { sentEvents.push(e); }),
}));

const speakCalls: Array<{ text: string }> = [];

beforeEach(() => {
  speakCalls.length = 0;
  sentEvents.length = 0;
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak: (u: any) => {
        speakCalls.push({ text: u.text });
        Promise.resolve().then(() => u.onend?.());
      },
      cancel: () => {},
      pause: () => {},
      resume: () => {},
      paused: false,
      speaking: false,
      getVoices: () => [],
    },
  });
  (window as any).SpeechSynthesisUtterance = function (text: string) {
    return { text, onend: null, onerror: null };
  };

  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, ttsProvider: 'browser' },
    modes: { ...DEFAULT_MODES, narration: true },
    settingsOpen: false,
  });
  useAudioStore.setState({
    ...useAudioStore.getState(),
    voiceState: 'listening',
    currentSegment: null,
    speechToasts: [],
    interruptBackoffUntil: 0,
    audioElement: null,
    isPlaying: false,
    userHasFloor: false,
    floorPhase: 'open',
    floorPaused: false,
    floorHeldSince: null,
    flushEpoch: 0,
    recentSpokenText: [],
  });
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
    greeting: null,
    entryMode: 'explore',
    areas: [],
    currentBriefing: null,
    streamChunks: [],
    streamingFinal: false,
    currentStreamChunk: null,
    currentStreamId: null,
  } as any);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function pushChunk(seq: number, text: string, isFinal = false, streamId = 's1') {
  useSessionStore.getState().handleServerEvent({
    type: 'narration:stream_chunk',
    payload: { streamId, seq, text, isFinal },
  } as any);
}

describe('orchestrator floor gate', () => {
  it('frozen drain: chunks arriving while the floor is held are neither consumed nor spoken; release drains in order', async () => {
    renderHook(() => useSessionOrchestrator());

    act(() => { useAudioStore.getState().duckForFloor(); });

    await act(async () => {
      pushChunk(0, 'First sentence.');
      pushChunk(1, 'Second sentence.', true);
      await new Promise(r => setTimeout(r, 30));
    });

    expect(speakCalls, 'nothing speaks while floor held').toHaveLength(0);
    expect(useSessionStore.getState().streamChunks.length, 'chunks not consumed while frozen').toBe(2);

    await act(async () => {
      useAudioStore.getState().resumeFromFloor('noise');
      await new Promise(r => setTimeout(r, 50));
    });

    expect(speakCalls.map(c => c.text)).toEqual(['First sentence.', 'Second sentence.']);
  });

  it('a new chunk while awaiting-response releases the floor (response started)', async () => {
    renderHook(() => useSessionOrchestrator());

    act(() => {
      useAudioStore.getState().duckForFloor();
      useAudioStore.getState().claimFloorForUtterance();
    });
    expect(useAudioStore.getState().floorPhase).toBe('awaiting-response');

    await act(async () => {
      pushChunk(0, 'Here is the answer.', true, 'turn-2');
      await new Promise(r => setTimeout(r, 50));
    });

    expect(useAudioStore.getState().userHasFloor).toBe(false);
    expect(speakCalls.map(c => c.text)).toEqual(['Here is the answer.']);
  });

  it('scheduleAdvance never sends command:next while the floor is held', async () => {
    vi.useFakeTimers();
    renderHook(() => useSessionOrchestrator());

    // HEATMAP phase schedules an auto-advance.
    act(() => {
      useAudioStore.getState().duckForFloor();
      useSessionStore.setState({
        ...useSessionStore.getState(),
        state: { phase: 'HEATMAP', areaIndex: 0, segmentIndex: 0, paused: false } as any,
        heatmap: null,
      } as any);
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(sentEvents.filter(e => e.type === 'command:next')).toHaveLength(0);

    // Floor opens → the rearmed timer fires.
    act(() => { useAudioStore.getState().resumeFromFloor('noise'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(sentEvents.filter(e => e.type === 'command:next').length).toBeGreaterThan(0);
  });

  it('flushEpoch bump kills the stale unspoken backlog', async () => {
    renderHook(() => useSessionOrchestrator());

    act(() => { useAudioStore.getState().duckForFloor(); });
    await act(async () => {
      pushChunk(0, 'Stale answer sentence one.');
      pushChunk(1, 'Stale answer sentence two.', true);
      await new Promise(r => setTimeout(r, 20));
    });
    expect(useSessionStore.getState().streamChunks.length).toBe(2);

    await act(async () => {
      useAudioStore.getState().claimFloorForUtterance(); // confirmed barge-in
      await new Promise(r => setTimeout(r, 20));
    });

    expect(useSessionStore.getState().streamChunks, 'stale backlog cleared').toHaveLength(0);
    expect(speakCalls, 'stale chunks never spoken').toHaveLength(0);
  });
});

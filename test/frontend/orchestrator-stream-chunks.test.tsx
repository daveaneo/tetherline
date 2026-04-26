/**
 * Streaming TTS playback — given N narration:stream_chunk events,
 * useSessionOrchestrator's stream player must call speak() exactly N
 * times in chunk order. Without this, the chunked answer pipeline
 * (R3+ code-walk briefings rely on it) silently drops chunks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSessionOrchestrator } from '../../packages/frontend/src/hooks/useSessionOrchestrator.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import { useSettingsStore } from '../../packages/frontend/src/state/settings-store.js';
import { DEFAULT_MODES, DEFAULT_SETTINGS } from '@tetherline/shared';

vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn() }));

const speakCalls: Array<{ text: string }> = [];

beforeEach(() => {
  speakCalls.length = 0;
  // Fake speechSynthesis: record each speak() and immediately fire onend
  // so the orchestrator's await speak() resolves and pulls the next chunk.
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak: (u: any) => {
        speakCalls.push({ text: u.text });
        // Fire onend on the next microtask so the orchestrator can advance.
        Promise.resolve().then(() => u.onend?.());
      },
      cancel: () => {},
      pause: () => {},
      resume: () => {},
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
  } as any);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('orchestrator drains stream_chunks in order', () => {
  it('three chunks → three speak() calls in chunk order', async () => {
    renderHook(() => useSessionOrchestrator());

    // Drive the chunks through the same path the WS handler uses.
    await act(async () => {
      useSessionStore.getState().handleServerEvent({
        type: 'narration:stream_chunk',
        payload: { streamId: 's1', seq: 0, text: 'First.', isFinal: false },
      } as any);
      useSessionStore.getState().handleServerEvent({
        type: 'narration:stream_chunk',
        payload: { streamId: 's1', seq: 1, text: 'Second.', isFinal: false },
      } as any);
      useSessionStore.getState().handleServerEvent({
        type: 'narration:stream_chunk',
        payload: { streamId: 's1', seq: 2, text: 'Third.', isFinal: true },
      } as any);
      // Let the orchestrator's drain loop process all chunks.
      await new Promise(r => setTimeout(r, 50));
    });

    expect(speakCalls.map(c => c.text)).toEqual(['First.', 'Second.', 'Third.']);
  });

  it('a chunk with a `range` flows through to currentStreamChunk for the CodePanel', async () => {
    renderHook(() => useSessionOrchestrator());

    await act(async () => {
      useSessionStore.getState().handleServerEvent({
        type: 'narration:stream_chunk',
        payload: {
          streamId: 'code-1',
          seq: 0,
          text: 'Walking through the issueToken function.',
          isFinal: true,
          range: [10, 18],
          filePath: 'src/auth.ts',
        },
      } as any);
      await new Promise(r => setTimeout(r, 30));
    });

    // After consume, currentStreamChunk holds the chunk including its
    // range — the CodePanel uses this to highlight the active lines.
    const cur = useSessionStore.getState().currentStreamChunk;
    expect(cur).toBeTruthy();
    expect(cur!.range).toEqual([10, 18]);
    expect(cur!.filePath).toBe('src/auth.ts');
    expect(speakCalls).toEqual([{ text: 'Walking through the issueToken function.' }]);
  });
});

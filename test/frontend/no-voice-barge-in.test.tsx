/**
 * REGRESSION GUARD: voice barge-in is intentionally disabled. The AI's own
 * audio bleeding into the mic was triggering self-interrupt — flushing AI
 * playback, signalling speaking_started, and frequently transcribing the
 * AI's own words as a question that prompted another reply.
 *
 * Hold-space PTT is now the only path that interrupts the AI. The mic
 * still listens for utterances, but:
 *   1. detection of speech (VAD) does NOT abort AI playback or send
 *      `user:speaking_started`
 *   2. transcripts arriving while `audioStore.isPlaying` are dropped
 *      (they're echo, not user speech)
 *
 * These tests drive useVoiceInput's Web Speech path because it's the
 * easiest to fake; the Whisper AudioCapture path uses identical logic
 * (see the matching no-flush, no-speaking_started edits in onSpeechStart).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useVoiceInput } from '../../packages/frontend/src/hooks/useVoiceInput.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import { useSettingsStore } from '../../packages/frontend/src/state/settings-store.js';
import { DEFAULT_MODES, DEFAULT_SETTINGS } from '@tetherline/shared';

const sentEvents: any[] = [];
vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({
  sendEvent: vi.fn((e: any) => { sentEvents.push(e); }),
}));

let activeRecognizer: any = null;
vi.mock('../../packages/frontend/src/lib/speech-recognition.js', () => ({
  VoiceCommandRecognizer: class {
    onSpeechStart: any = null; onSpeechEnd: any = null;
    onCommand: any = null; onUtterance: any = null;
    onError: any = null; onStateChange: any = null;
    isSupported() { return true; }
    start() { activeRecognizer = this; }
    stop() {}
  },
}));
vi.mock('../../packages/frontend/src/lib/audio-capture.js', () => ({
  AudioCapture: class { start() {} stop() {} },
}));

const originalFetch = global.fetch;
beforeEach(() => {
  sentEvents.length = 0;
  activeRecognizer = null;
  global.fetch = vi.fn(async (url: any) => {
    if (String(url).includes('/audio/status')) {
      return { ok: true, json: async () => ({ whisper: false }) } as any;
    }
    return originalFetch(url);
  }) as any;

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
  });
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
    greeting: null,
    entryMode: 'explore',
    areas: [],
  } as any);
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe('voice barge-in is disabled (no self-interrupt loop)', () => {
  it('VAD onSpeechStart does NOT abort AI playback or send speaking_started', async () => {
    const flushSpy = vi.spyOn(useAudioStore.getState(), 'flushOnInterrupt');
    const hook = renderHook(() => useVoiceInput());
    await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    act(() => { hook.result.current.startListening(); });
    expect(activeRecognizer).not.toBeNull();

    // Simulate the recognizer detecting speech (e.g., AI audio bleed).
    act(() => { activeRecognizer.onSpeechStart?.(); });

    expect(flushSpy).not.toHaveBeenCalled();
    expect(sentEvents.some(e => e.type === 'user:speaking_started')).toBe(false);
    expect(sentEvents.some(e => e.type === 'command:pause')).toBe(false);
    // UI feedback still updates so the orb shows we heard something.
    expect(useAudioStore.getState().voiceState).toBe('hearing');
  });

  it('transcript arriving while AI is playing is dropped (echo, not user speech)', async () => {
    const hook = renderHook(() => useVoiceInput());
    await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    act(() => { hook.result.current.startListening(); });

    // Pretend the AI is mid-sentence: isPlaying=true.
    useAudioStore.setState({ ...useAudioStore.getState(), isPlaying: true });

    // The recognizer transcribes a chunk of the AI's own voice.
    act(() => {
      activeRecognizer.onUtterance?.('this project is a code review tool that walks you through changes');
    });

    expect(sentEvents.some(e => e.type === 'user:utterance')).toBe(false);
    // No conversation history entry either — the AI shouldn't think the user said this.
    expect(useSessionStore.getState().conversationHistory).toEqual([]);
  });

  it('transcript arriving while AI is silent is processed normally', async () => {
    const hook = renderHook(() => useVoiceInput());
    await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    act(() => { hook.result.current.startListening(); });

    useAudioStore.setState({ ...useAudioStore.getState(), isPlaying: false });

    act(() => {
      activeRecognizer.onUtterance?.('what does the auth module do?');
    });

    expect(sentEvents.some(e => e.type === 'user:utterance')).toBe(true);
  });
});

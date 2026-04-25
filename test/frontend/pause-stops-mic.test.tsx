/**
 * REGRESSION GUARD: pressing pause must fully tear down the mic. Reported
 * on 2026-04-21 as "when I pause it still listens." Pause now == full stop;
 * resume rehydrates the mic iff the user had it on before.
 *
 * We drive useVoiceInput (browser STT path, easier to fake than Whisper
 * AudioCapture) and assert: (1) recognizer.stop() is called on pause,
 * (2) voiceState flips to 'idle', (3) recognizer.start() is called again
 * when paused flips back to false.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useVoiceInput } from '../../packages/frontend/src/hooks/useVoiceInput.js';
import { useSessionOrchestrator } from '../../packages/frontend/src/hooks/useSessionOrchestrator.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import { useSettingsStore } from '../../packages/frontend/src/state/settings-store.js';
import { DEFAULT_MODES, DEFAULT_SETTINGS } from '@tetherline/shared';

vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn() }));

// Fake recognizer — stands in for the Web Speech API wrapper.
const recognizerCalls = { start: 0, stop: 0 };
vi.mock('../../packages/frontend/src/lib/speech-recognition.js', () => ({
  VoiceCommandRecognizer: class {
    onSpeechStart: (() => void) | null = null;
    onSpeechEnd: (() => void) | null = null;
    onCommand: ((c: string) => void) | null = null;
    onUtterance: ((t: string) => void) | null = null;
    onError: ((e: string) => void) | null = null;
    onStateChange: ((s: string) => void) | null = null;
    isSupported() { return true; }
    start() { recognizerCalls.start++; }
    stop() { recognizerCalls.stop++; }
  },
}));

// AudioCapture isn't used on the browser path but it's imported — stub it.
vi.mock('../../packages/frontend/src/lib/audio-capture.js', () => ({
  AudioCapture: class { start() {} stop() {} },
}));

// Force /audio/status to report "no whisper" so we take the Web Speech branch.
const originalFetch = global.fetch;
beforeEach(() => {
  recognizerCalls.start = 0;
  recognizerCalls.stop = 0;
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
  });
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
    greeting: null,
    entryMode: 'explore',
    areas: [],
  } as any);

  // Ensure speechSynthesis exists so the orchestrator's speak() no-ops don't explode.
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: { speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [] },
  });
  (window as any).SpeechSynthesisUtterance = function (text: string) {
    return { text, onend: null, onerror: null };
  };
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe('pause tears down the mic', () => {
  it('stops the recognizer when paused flips true, and voiceState becomes idle', async () => {
    const hook = renderHook(() => {
      useSessionOrchestrator();
      return useVoiceInput();
    });

    // Let the audio/status fetch resolve, then start the mic.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    act(() => { hook.result.current.startListening(); });
    expect(recognizerCalls.start).toBe(1);
    expect(recognizerCalls.stop).toBe(0);

    // User hits pause.
    await act(async () => {
      useSessionStore.setState({
        ...useSessionStore.getState(),
        state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: true } as any,
      } as any);
      await new Promise(r => setTimeout(r, 0));
    });

    expect(recognizerCalls.stop).toBe(1);
    expect(useAudioStore.getState().voiceState).toBe('idle');
    expect(hook.result.current.listening).toBe(false);
  });

  it('restarts the mic on resume iff it was listening before pause', async () => {
    const hook = renderHook(() => {
      useSessionOrchestrator();
      return useVoiceInput();
    });

    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    act(() => { hook.result.current.startListening(); });
    expect(recognizerCalls.start).toBe(1);

    // Pause
    await act(async () => {
      useSessionStore.setState({
        ...useSessionStore.getState(),
        state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: true } as any,
      } as any);
      await new Promise(r => setTimeout(r, 0));
    });
    expect(recognizerCalls.stop).toBe(1);

    // Resume — mic should come back on because it was on before pause.
    await act(async () => {
      useSessionStore.setState({
        ...useSessionStore.getState(),
        state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
      } as any);
      await new Promise(r => setTimeout(r, 0));
    });
    expect(recognizerCalls.start).toBe(2);
  });

  it('does not auto-start mic on resume if it was never on', async () => {
    const hook = renderHook(() => {
      useSessionOrchestrator();
      return useVoiceInput();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(recognizerCalls.start).toBe(0);

    // Pause without ever starting mic, then resume.
    await act(async () => {
      useSessionStore.setState({
        ...useSessionStore.getState(),
        state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: true } as any,
      } as any);
      await new Promise(r => setTimeout(r, 0));
    });
    await act(async () => {
      useSessionStore.setState({
        ...useSessionStore.getState(),
        state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
      } as any);
      await new Promise(r => setTimeout(r, 0));
    });
    expect(recognizerCalls.start).toBe(0);
    // Make sure the hook's listening flag also never went true.
    expect(hook.result.current.listening).toBe(false);
  });
});

/**
 * Push-to-talk: hold space to talk, tap space to pause/resume. Implemented
 * in useVoiceInput. Hold beyond ~150ms engages the mic and sends
 * `user:speaking_started`; release sends `user:speaking_stopped` and tears
 * the mic back down (if it wasn't on before). A short tap falls through to
 * the legacy pause/resume toggle.
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

const recognizerCalls = { start: 0, stop: 0 };
vi.mock('../../packages/frontend/src/lib/speech-recognition.js', () => ({
  VoiceCommandRecognizer: class {
    onSpeechStart: any = null; onSpeechEnd: any = null;
    onCommand: any = null; onUtterance: any = null;
    onError: any = null; onStateChange: any = null;
    isSupported() { return true; }
    start() { recognizerCalls.start++; }
    stop() { recognizerCalls.stop++; }
  },
}));
vi.mock('../../packages/frontend/src/lib/audio-capture.js', () => ({
  AudioCapture: class { start() {} stop() {} },
}));

const originalFetch = global.fetch;
beforeEach(() => {
  sentEvents.length = 0;
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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  global.fetch = originalFetch;
});

function pressSpace() {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
}
function releaseSpace() {
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' }));
}

describe('push-to-talk on space', () => {
  it('hold > 150ms engages PTT: starts mic, sends user:speaking_started, flushes AI audio', async () => {
    vi.useFakeTimers();
    const flushSpy = vi.spyOn(useAudioStore.getState(), 'flushOnInterrupt');
    const hook = renderHook(() => useVoiceInput());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    act(() => { pressSpace(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(useAudioStore.getState().voiceState).toBe('hearing');
    expect(sentEvents.some(e => e.type === 'user:speaking_started')).toBe(true);
    expect(flushSpy).toHaveBeenCalled();
    expect(recognizerCalls.start).toBe(1);
    expect(hook.result.current.listening).toBe(true);
  });

  it('release after a hold sends user:speaking_stopped and tears mic back down', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useVoiceInput());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    act(() => { pressSpace(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(recognizerCalls.start).toBe(1);

    act(() => { releaseSpace(); });
    expect(sentEvents.some(e => e.type === 'user:speaking_stopped')).toBe(true);
    expect(recognizerCalls.stop).toBe(1);
    expect(hook.result.current.listening).toBe(false);
  });

  it('a quick tap (< 150ms) sends pause/resume, NOT speaking_started', async () => {
    vi.useFakeTimers();
    renderHook(() => useVoiceInput());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    act(() => { pressSpace(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    act(() => { releaseSpace(); });

    expect(sentEvents.some(e => e.type === 'user:speaking_started')).toBe(false);
    expect(sentEvents.some(e => e.type === 'command:pause')).toBe(true);
    expect(recognizerCalls.start).toBe(0);
  });

  it('keyboard repeat events do not re-engage PTT', async () => {
    vi.useFakeTimers();
    renderHook(() => useVoiceInput());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    act(() => { pressSpace(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(recognizerCalls.start).toBe(1);

    // Simulate OS auto-repeat — should be ignored.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true }));
    });
    expect(recognizerCalls.start).toBe(1);
  });

  it('does not engage PTT while phase is IDLE (lobby)', async () => {
    vi.useFakeTimers();
    useSessionStore.setState({
      ...useSessionStore.getState(),
      state: { phase: 'IDLE' } as any,
    } as any);
    renderHook(() => useVoiceInput());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    act(() => { pressSpace(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(recognizerCalls.start).toBe(0);
    expect(sentEvents.some(e => e.type === 'user:speaking_started')).toBe(false);
  });

  it('does not capture space while typing in an input field', async () => {
    vi.useFakeTimers();
    renderHook(() => useVoiceInput());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(recognizerCalls.start).toBe(0);
    document.body.removeChild(input);
  });
});

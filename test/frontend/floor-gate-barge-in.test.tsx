/**
 * REGRESSION GUARD: the AI must NEVER talk over the user — and the user's
 * mic must never destructively self-interrupt the AI.
 *
 * History: voice barge-in was once fully disabled because the AI's own
 * audio bled into the mic, hard-flushed playback, and re-transcribed its
 * own words as questions (self-interrupt loop). That protected the AI but
 * let it TALK OVER THE USER (live bug 2026-06-09: queued clips resumed in
 * the user's mid-sentence pauses; its own "say 'back to the tour'" nudge
 * echo-executed resumeTour 12s later).
 *
 * The replacement contract — duck-and-confirm:
 *   1. speech detected → playback soft-PAUSES (resumable; NO hard flush,
 *      isPlaying stays true) and the user takes the floor;
 *   2. transcripts are content-matched against recently-AI-spoken text:
 *      matches are self-echo → muted log entry + playback resumes
 *      (this is what timing gates structurally cannot catch);
 *   3. a novel transcript is REAL user speech → hard flush + utterance,
 *      floor stays closed until the turn's response arrives;
 *   4. noise (no usable transcript) → playback resumes from the pause.
 *
 * These tests drive useVoiceInput's Web Speech path because it's the
 * easiest to fake; the Whisper AudioCapture path uses the same store
 * methods (duckForFloor/confirmFloor in audio-capture.ts, the same
 * handleTranscript gate order).
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

function fakeAudioElement() {
  return {
    pause: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    currentTime: 5,
    duration: 30,
  } as unknown as HTMLAudioElement;
}

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
    userHasFloor: false,
    floorPhase: 'open',
    floorPaused: false,
    floorHeldSince: null,
    flushEpoch: 0,
    recentSpokenText: [],
    lastTtsEndAt: 0,
    lastNarrationAt: 0,
  });
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
    greeting: null,
    entryMode: 'explore',
    areas: [],
    conversationHistory: [],
  } as any);
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

async function startWebSpeech() {
  const hook = renderHook(() => useVoiceInput());
  await act(async () => { await new Promise(r => setTimeout(r, 5)); });
  act(() => { hook.result.current.startListening(); });
  expect(activeRecognizer).not.toBeNull();
  return hook;
}

describe('floor gate — duck-and-confirm barge-in', () => {
  it('speech-start DUCKS playback (resumable pause, no hard flush) and signals speaking_started', async () => {
    const flushSpy = vi.spyOn(useAudioStore.getState(), 'flushOnInterrupt');
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });
    await startWebSpeech();

    act(() => { activeRecognizer.onSpeechStart?.(); });

    // Soft pause, not the destructive flush.
    expect(flushSpy).not.toHaveBeenCalled();
    expect((el.pause as any).mock.calls.length).toBeGreaterThan(0);
    expect(el.currentTime, 'position preserved for resume').toBe(5);
    const a = useAudioStore.getState();
    expect(a.userHasFloor).toBe(true);
    expect(a.floorPaused).toBe(true);
    // isPlaying stays true: flipping it would stamp lastTtsEndAt and
    // re-arm the echo gate against the user's REAL transcript.
    expect(a.isPlaying).toBe(true);
    expect(a.lastTtsEndAt).toBe(0);
    // The backend must learn the user holds the floor (it holds this
    // turn's chunks instead of dropping them).
    expect(sentEvents.some(e => e.type === 'user:speaking_started')).toBe(true);
    expect(sentEvents.some(e => e.type === 'command:pause')).toBe(false);
    expect(a.voiceState).toBe('hearing');
  });

  it('transcript matching recently-AI-spoken text is self-echo: muted, dropped, playback resumes', async () => {
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });
    await startWebSpeech();

    // The AI just said this (the live bug's exact shape).
    useAudioStore.getState().recordSpokenText(
      'Take your time exploring. Say "back to the tour" whenever you\'re ready to continue.',
    );

    act(() => { activeRecognizer.onSpeechStart?.(); });
    act(() => { activeRecognizer.onUtterance?.('Back to the tour.'); });

    // Never reaches the backend — no utterance, no command execution.
    expect(sentEvents.some(e => e.type === 'user:utterance')).toBe(false);
    expect(sentEvents.some(e => String(e.type).startsWith('command:'))).toBe(false);
    // Visible as a muted entry, not silently eaten.
    const history = useSessionStore.getState().conversationHistory;
    expect(history).toHaveLength(1);
    expect(history[0].muted).toBe(true);
    expect(history[0].speaker).toBe('you');
    // Playback resumed from the pause point; floor reopened.
    expect((el.play as any).mock.calls.length).toBeGreaterThan(0);
    expect(useAudioStore.getState().userHasFloor).toBe(false);
    expect(sentEvents.some(e => e.type === 'user:speaking_stopped')).toBe(true);
  });

  it('novel transcript while floor held is REAL speech: hard flush + utterance, floor awaits the response', async () => {
    const flushSpy = vi.spyOn(useAudioStore.getState(), 'flushOnInterrupt');
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });
    await startWebSpeech();

    act(() => { activeRecognizer.onSpeechStart?.(); });
    act(() => { activeRecognizer.onUtterance?.('what does the auth module actually do here?'); });

    expect(flushSpy).toHaveBeenCalled();
    expect(sentEvents.some(e => e.type === 'user:utterance')).toBe(true);
    const a = useAudioStore.getState();
    expect(a.userHasFloor).toBe(true);
    expect(a.floorPhase).toBe('awaiting-response');
    expect(sentEvents.some(e => e.type === 'user:speaking_stopped')).toBe(true);
  });

  it('noise rollback: duck then resume restores playback and reopens the floor', () => {
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });

    useAudioStore.getState().duckForFloor();
    expect(useAudioStore.getState().floorPaused).toBe(true);
    useAudioStore.getState().resumeFromFloor('noise');

    expect((el.play as any).mock.calls.length).toBeGreaterThan(0);
    const a = useAudioStore.getState();
    expect(a.userHasFloor).toBe(false);
    expect(a.floorPhase).toBe('open');
    expect(a.floorPaused).toBe(false);
  });

  it('transcript arriving with no floor episode while AI is silent is processed normally', async () => {
    await startWebSpeech();
    useAudioStore.setState({ ...useAudioStore.getState(), isPlaying: false });

    act(() => { activeRecognizer.onUtterance?.('what does the auth module do?'); });

    expect(sentEvents.some(e => e.type === 'user:utterance')).toBe(true);
  });

  it('time gates still drop floor-less transcripts while AI is playing (legacy echo path)', async () => {
    const hook = await startWebSpeech();
    void hook;
    useAudioStore.setState({ ...useAudioStore.getState(), isPlaying: true });

    // No onSpeechStart → no floor episode → classic gate applies.
    act(() => {
      activeRecognizer.onUtterance?.('this project is a code review tool that walks you through changes');
    });

    expect(sentEvents.some(e => e.type === 'user:utterance')).toBe(false);
    const history = useSessionStore.getState().conversationHistory;
    expect(history).toHaveLength(1);
    expect(history[0].muted).toBe(true);
  });
});

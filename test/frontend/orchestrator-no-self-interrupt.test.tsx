/**
 * REGRESSION GUARD: useSessionOrchestrator must not trigger a second TTS play
 * that cuts off the first. Reported multiple times in 2026-04 as "AI interrupts
 * itself with its voice."
 *
 * The historical offenders:
 *   1. Main orchestration's ANALYZING case spoke the greeting AND the dedicated
 *      greeting useEffect also spoke it → two speak() calls raced and aborted
 *      each other mid-word.
 *   2. On any phase transition the main orch unconditionally aborted abortRef,
 *      which clobbered a greeting that the greeting effect had started. This
 *      fired immediately when the backend flipped ANALYZING → OVERVIEW (explore)
 *      while the greeting was still playing.
 *
 * These tests drive the hook with jsdom + fake timers and count calls to
 * speechSynthesis.speak — exactly one call per greeting delivery is the
 * invariant. A second call is a self-interrupt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSessionOrchestrator } from '../../packages/frontend/src/hooks/useSessionOrchestrator.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import { useSettingsStore } from '../../packages/frontend/src/state/settings-store.js';
import { DEFAULT_MODES, DEFAULT_SETTINGS } from '@tetherline/shared';

vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn() }));

// Force the speechSynthesis fallback path in speak() — simpler than mocking
// fetch + Audio + createObjectURL for the OpenAI TTS branch.
const speakCalls: Array<{ text: string; at: number }> = [];
const cancelCalls: number[] = [];
let utteranceOnEnd: (() => void) | null = null;

beforeEach(() => {
  speakCalls.length = 0;
  cancelCalls.length = 0;
  utteranceOnEnd = null;

  // Fresh mock speechSynthesis each test
  const fakeSynth = {
    speak: vi.fn((u: { text: string; onend?: () => void }) => {
      speakCalls.push({ text: u.text, at: Date.now() });
      utteranceOnEnd = u.onend ?? null;
    }),
    cancel: vi.fn(() => { cancelCalls.push(Date.now()); }),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: () => [],
  };
  // jsdom doesn't ship speechSynthesis — install our own.
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: fakeSynth });
  // SpeechSynthesisUtterance just needs to be constructible and expose text.
  (window as any).SpeechSynthesisUtterance = function (text: string) {
    return { text, rate: 1, onend: null as null | (() => void), onerror: null as null | (() => void) };
  };

  // Reset settings: force browser TTS so we don't hit the fetch/Audio path.
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, ttsProvider: 'browser' },
    modes: { ...DEFAULT_MODES, narration: true },
    settingsOpen: false,
  });

  // Reset audio store
  useAudioStore.setState({
    ...useAudioStore.getState(),
    voiceState: 'listening',
    currentSegment: null,
    speechToasts: [],
    interruptBackoffUntil: 0,
    audioElement: null,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function primeSession(opts: {
  phase: string;
  greeting?: string | null;
  entryMode?: 'explore' | 'walkthrough' | null;
}) {
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: opts.phase as any, areaIndex: 0, segmentIndex: 0, paused: false } as any,
    greeting: opts.greeting ?? null,
    entryMode: opts.entryMode ?? null,
    areas: [],
    proposal: null,
    heatmap: null,
    concerns: [],
    recap: null,
    conceptualSteps: [],
    conversationHistory: [],
    currentBriefing: null,
    quickPreview: null,
    streamedNarratives: new Map(),
    comprehensionMap: new Map(),
    breadcrumb: { text: '', depth: 0, frames: [] },
    analysisProgress: null,
    visualLayer: 1,
    connected: true,
    error: null,
    skillResult: null,
    skillClarification: null,
  } as any);
}

describe('useSessionOrchestrator does not self-interrupt', () => {
  it('ANALYZING phase + greeting → speechSynthesis.speak fires exactly once', async () => {
    vi.useFakeTimers();
    primeSession({ phase: 'ANALYZING', greeting: 'Welcome to Tetherline.', entryMode: 'explore' });

    renderHook(() => useSessionOrchestrator());

    // Let React effects flush, then settle the 250ms greeting debounce
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(speakCalls.length).toBe(1);
    expect(speakCalls[0].text).toBe('Welcome to Tetherline.');
  });

  it('phase transition ANALYZING → OVERVIEW-explore does not cut greeting mid-word', async () => {
    vi.useFakeTimers();
    primeSession({ phase: 'ANALYZING', greeting: 'Hello from Tetherline.', entryMode: 'explore' });

    renderHook(() => useSessionOrchestrator());

    // Greeting debounce fires and starts speaking
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(speakCalls.length).toBe(1);
    const cancelsBeforeTransition = cancelCalls.length;

    // Backend finishes analysis and flips to OVERVIEW. In explore mode this is
    // a "silent" phase for the orchestrator — it must NOT abort the in-flight
    // greeting.
    await act(async () => {
      useSessionStore.setState({
        ...useSessionStore.getState(),
        state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
      } as any);
      await vi.advanceTimersByTimeAsync(50);
    });

    // Still exactly one speak call — no restart.
    expect(speakCalls.length).toBe(1);
    // No extra speechSynthesis.cancel calls from an abort handler.
    expect(cancelCalls.length).toBe(cancelsBeforeTransition);
  });

  it('rapid-fire greetings within the 250ms coalescing window collapse to one speak', async () => {
    vi.useFakeTimers();
    primeSession({ phase: 'ANALYZING', greeting: 'First.', entryMode: 'explore' });

    renderHook(() => useSessionOrchestrator());

    // Burst three greetings inside 200ms — should coalesce to the last one only
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await act(async () => {
      useSessionStore.setState({ ...useSessionStore.getState(), greeting: 'Second.' } as any);
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      useSessionStore.setState({ ...useSessionStore.getState(), greeting: 'Third and final.' } as any);
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(speakCalls.length).toBe(1);
    expect(speakCalls[0].text).toBe('Third and final.');
  });
});

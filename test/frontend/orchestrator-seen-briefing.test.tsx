/**
 * Seen% wiring: when a briefing finishes playing, the orchestrator must
 * report `audio:segment_finished` TAGGED BY the briefing's id — not by
 * matching the spoken text against currentBriefing.text.
 *
 * Live bug 2026-06-10: Seen% sat at 0% all session. The sender required
 * `spokenText === currentBriefing.text` (strict equality), which diverges
 * whenever the spoken opener is abbreviated (session-start re-entry:
 * "Picking up where we left off.") or a greeting/briefing interleaves —
 * so the event was never sent and markSeen() stayed dead in production.
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

// Controllable speech: utterances queue and only finish when we fire them,
// so we can interrupt a briefing mid-playback (the aborted-speech case).
let pendingUtterances: any[] = [];
function fireSpeech() {
  const us = pendingUtterances;
  pendingUtterances = [];
  us.forEach(u => u.onend?.());
}

beforeEach(() => {
  sentEvents.length = 0;
  pendingUtterances = [];
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak: (u: any) => { pendingUtterances.push(u); },
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
  } as any);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function dispatchBriefing(briefingId: string, text: string) {
  useSessionStore.getState().handleServerEvent({
    type: 'narration:briefing',
    payload: {
      briefingId, layer: 'module', title: briefingId, text,
      estimatedSeconds: 10, talkingPoints: [], children: [], parent: null,
    },
  } as any);
}

async function settleSpeech() {
  // Debounce (250ms) → speak queues → fire onend → .then() microtask runs.
  await act(async () => { await new Promise(r => setTimeout(r, 320)); });
  await act(async () => { fireSpeech(); await new Promise(r => setTimeout(r, 20)); });
}

const segmentFinishedIds = () =>
  sentEvents.filter(e => e.type === 'audio:segment_finished').map(e => e.payload.segmentId);

describe('orchestrator Seen% sender', () => {
  it('reports segment_finished tagged by briefingId even when the spoken opener is abbreviated', async () => {
    renderHook(() => useSessionOrchestrator());

    act(() => {
      dispatchBriefing('module/core', 'Picking up where we left off.');
      // Seed the live divergence: currentBriefing holds the FULL opener while
      // the spoken greeting is the abbreviated one. String equality dies here.
      const sb = useSessionStore.getState();
      useSessionStore.setState({
        currentBriefing: { ...(sb.currentBriefing as any), text: 'Core records audio and buffers samples for the entire fine-tuning pipeline.' },
      } as any);
    });

    await settleSpeech();

    expect(segmentFinishedIds(), 'must credit the briefing by id, not by text match').toEqual(['module/core']);
  });

  it('does not report seen for a plain greeting (no briefingId)', async () => {
    renderHook(() => useSessionOrchestrator());
    act(() => {
      useSessionStore.getState().handleServerEvent({
        type: 'narration:greeting', payload: { text: 'Welcome back to the project.' },
      } as any);
    });
    await settleSpeech();
    expect(segmentFinishedIds()).toHaveLength(0);
  });

  it('does not report seen during a walkthrough (tour auto-advance owns that path)', async () => {
    useSessionStore.setState({
      state: { phase: 'AREA_WALKTHROUGH', areaIndex: 0, segmentIndex: 0, paused: false } as any,
    } as any);
    renderHook(() => useSessionOrchestrator());
    act(() => { dispatchBriefing('module/core', 'A core briefing during a tour.'); });
    await settleSpeech();
    expect(segmentFinishedIds()).toHaveLength(0);
  });

  it('aborted briefing playback is not credited; the one that finishes is', async () => {
    renderHook(() => useSessionOrchestrator());

    // Briefing A starts speaking…
    act(() => { dispatchBriefing('module/core', 'Core briefing being spoken.'); });
    await act(async () => { await new Promise(r => setTimeout(r, 320)); });
    expect(pendingUtterances.length, 'A should be mid-playback').toBe(1);

    // …then B arrives and interrupts (>250ms later → not coalesced).
    act(() => { dispatchBriefing('module/utils', 'Utils briefing interrupts.'); });
    await act(async () => { await new Promise(r => setTimeout(r, 320)); });

    // Fire onend on everything; A's controller is aborted so only B credits.
    await act(async () => { fireSpeech(); await new Promise(r => setTimeout(r, 20)); });

    expect(segmentFinishedIds()).toEqual(['module/utils']);
  });
});

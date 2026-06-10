/**
 * audio-store floor semantics: duck is a RESUMABLE pause that leaves the
 * playback bookkeeping untouched (isPlaying stays true, lastTtsEndAt not
 * stamped — both feed the echo gates and must not fire on a duck), while
 * flushOnInterrupt stays the destructive path and now bumps flushEpoch so
 * the orchestrator can deterministically abort a hard-stopped clip.
 * Plus the self-echo ring buffer's matching rules.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';

function fakeAudioElement() {
  return {
    pause: vi.fn(),
    play: vi.fn(() => Promise.resolve()),
    currentTime: 7,
    duration: 42,
  } as unknown as HTMLAudioElement;
}

beforeEach(() => {
  useAudioStore.setState({
    ...useAudioStore.getState(),
    audioElement: null,
    isPlaying: false,
    queue: [],
    currentSegment: null,
    userHasFloor: false,
    floorPhase: 'open',
    floorPaused: false,
    floorHeldSince: null,
    flushEpoch: 0,
    recentSpokenText: [],
    lastTtsEndAt: 0,
    lastNarrationAt: 0,
  });
});

describe('floor pause/resume', () => {
  it('duckForFloor pauses without touching position, isPlaying, or lastTtsEndAt', () => {
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });

    useAudioStore.getState().duckForFloor();

    const s = useAudioStore.getState();
    expect((el.pause as any).mock.calls.length).toBe(1);
    expect(el.currentTime).toBe(7);
    expect(s.isPlaying).toBe(true);
    expect(s.lastTtsEndAt).toBe(0);
    expect(s.userHasFloor).toBe(true);
    expect(s.floorPhase).toBe('provisional');
    expect(s.floorPaused).toBe(true);
    expect(s.floorHeldSince).not.toBeNull();
  });

  it('duckForFloor is idempotent — a second call does not re-pause or reset the phase', () => {
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });

    useAudioStore.getState().duckForFloor();
    useAudioStore.getState().confirmFloor();
    useAudioStore.getState().duckForFloor(); // VAD re-trigger

    expect((el.pause as any).mock.calls.length).toBe(1);
    expect(useAudioStore.getState().floorPhase).toBe('confirmed');
  });

  it('duck with nothing playing still takes the floor (blocks the drain loop)', () => {
    useAudioStore.getState().duckForFloor();
    const s = useAudioStore.getState();
    expect(s.userHasFloor).toBe(true);
    expect(s.floorPaused).toBe(false);
  });

  it('resumeFromFloor plays from the pause point and fully reopens', () => {
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });
    useAudioStore.getState().duckForFloor();

    useAudioStore.getState().resumeFromFloor('noise');

    const s = useAudioStore.getState();
    expect((el.play as any).mock.calls.length).toBe(1);
    expect(s.userHasFloor).toBe(false);
    expect(s.floorPhase).toBe('open');
    expect(s.floorPaused).toBe(false);
    expect(s.floorHeldSince).toBeNull();
    expect(s.isPlaying).toBe(true); // segment lifecycle untouched
  });

  it('resumeFromFloor without a held floor is a no-op', () => {
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el });
    useAudioStore.getState().resumeFromFloor('timeout');
    expect((el.play as any).mock.calls.length).toBe(0);
  });

  it('claimFloorForUtterance hard-flushes and parks the floor at awaiting-response', () => {
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });
    useAudioStore.getState().duckForFloor();
    const epochBefore = useAudioStore.getState().flushEpoch;

    useAudioStore.getState().claimFloorForUtterance();

    const s = useAudioStore.getState();
    expect(s.flushEpoch).toBe(epochBefore + 1);
    expect(s.isPlaying).toBe(false); // destructive path
    expect(s.queue).toEqual([]);
    expect(s.userHasFloor).toBe(true);
    expect(s.floorPhase).toBe('awaiting-response');
    expect(s.floorPaused).toBe(false);
  });

  it('flushOnInterrupt bumps flushEpoch and clears floorPaused', () => {
    const el = fakeAudioElement();
    useAudioStore.setState({ ...useAudioStore.getState(), audioElement: el, isPlaying: true });
    useAudioStore.getState().duckForFloor();

    useAudioStore.getState().flushOnInterrupt();

    const s = useAudioStore.getState();
    expect(s.flushEpoch).toBe(1);
    expect(s.floorPaused).toBe(false);
    expect(s.isPlaying).toBe(false);
  });

  it('releaseFloor reopens from awaiting-response', () => {
    useAudioStore.getState().duckForFloor();
    useAudioStore.getState().claimFloorForUtterance();
    useAudioStore.getState().releaseFloor();
    const s = useAudioStore.getState();
    expect(s.userHasFloor).toBe(false);
    expect(s.floorPhase).toBe('open');
  });
});

describe('self-echo ring buffer', () => {
  it('matches a transcript that is a fragment of recently spoken text (punctuation/case-insensitive)', () => {
    useAudioStore.getState().recordSpokenText(
      'Take your time exploring. Say "back to the tour" whenever you\'re ready to continue.',
    );
    expect(useAudioStore.getState().matchesRecentSpokenText('Back to the tour.')).toBe(true);
    expect(useAudioStore.getState().matchesRecentSpokenText('back to the tour')).toBe(true);
  });

  it('matches when the transcript swallows a short spoken phrase whole', () => {
    useAudioStore.getState().recordSpokenText('Want me to go deeper?');
    expect(useAudioStore.getState().matchesRecentSpokenText('want me to go deeper huh')).toBe(true);
  });

  it('does not match novel user speech', () => {
    useAudioStore.getState().recordSpokenText('The core module handles ingestion and retries.');
    expect(useAudioStore.getState().matchesRecentSpokenText('what does the auth module do?')).toBe(false);
  });

  it('never matches tiny transcripts (min-length guard)', () => {
    useAudioStore.getState().recordSpokenText('Okay, moving on to the next area now.');
    expect(useAudioStore.getState().matchesRecentSpokenText('on')).toBe(false);
    expect(useAudioStore.getState().matchesRecentSpokenText('next')).toBe(false);
  });

  it('expires entries outside the 20s window', () => {
    vi.useFakeTimers();
    try {
      useAudioStore.getState().recordSpokenText('Say back to the tour whenever you are ready.');
      vi.setSystemTime(Date.now() + 25_000);
      expect(useAudioStore.getState().matchesRecentSpokenText('back to the tour')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps at most 10 entries', () => {
    for (let i = 0; i < 15; i++) {
      useAudioStore.getState().recordSpokenText(`Spoken sentence number ${i} about the codebase.`);
    }
    expect(useAudioStore.getState().recentSpokenText.length).toBe(10);
  });
});

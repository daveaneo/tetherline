import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../state/session-store.js';
import { useAudioStore } from '../state/audio-store.js';
import { useSettingsStore } from '../state/settings-store.js';
import { sendEvent } from '../lib/ws-client.js';
import { TtsPrefetch } from '../lib/tts-prefetch.js';
import type { NarrationSegment } from '@tetherline/shared';
import { API_PREFIX } from '@tetherline/shared';

// How many upcoming sentences to synthesize ahead while the current one plays.
// Synthesis ~1s, audio ~2-4s, so 2 ahead keeps the queue gap-free without
// spending on chunks the user is likely to barge over.
const PREFETCH_AHEAD = 2;

export function useSessionOrchestrator() {
  const state = useSessionStore(s => s.state);
  const areas = useSessionStore(s => s.areas);
  const entryMode = useSessionStore(s => s.entryMode);
  const modes = useSettingsStore(s => s.modes);
  const { setCurrentSegment, setPlaying, clearQueue } = useAudioStore();
  const ttsProvider = useSettingsStore(s => s.settings.ttsProvider);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // One-time "voice downgraded to browser TTS" notice (per mount).
  const ttsDowngradeNotifiedRef = useRef(false);
  const lastPhaseRef = useRef<string>('IDLE');
  const lastAreaIndexRef = useRef<number>(-1);
  const lastSegmentIndexRef = useRef<number>(-1);
  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against the effect firing multiple times for the same state
  const activeRunRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const postAnswerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // FLOOR GATE: resolves when the user no longer holds the conversational
  // floor (or the signal aborts — abort always wins so teardown can't hang
  // on a stuck floor). This is the single chokepoint that guarantees no new
  // TTS clip ever STARTS while the user is speaking.
  const awaitFloorOpen = useCallback((signal?: AbortSignal): Promise<void> => {
    if (!useAudioStore.getState().userHasFloor) return Promise.resolve();
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        unsub();
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const unsub = useAudioStore.subscribe((s) => {
        if (!s.userHasFloor) finish();
      });
      signal?.addEventListener('abort', finish, { once: true });
    });
  }, []);

  // Synthesize one chunk's audio via the backend TTS route. Returns the Blob,
  // or null on any failure (caller falls back to browser TTS). Stable — the
  // prefetch pipeline and on-demand playback both call it.
  const fetchTtsBlob = useCallback(async (text: string, signal?: AbortSignal): Promise<Blob | null> => {
    try {
      const res = await fetch(`${API_PREFIX}/audio/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  }, []);

  // Pipelines TTS: the drain loop prefetches the NEXT sentence's audio while the
  // current one plays, so the serialized queue never stalls on a synthesis
  // round-trip (the "speaks a couple sentences then pauses" gap). One instance
  // per hook; prefetch is fetch-only (no playback) so it never touches the floor.
  const prefetchRef = useRef<TtsPrefetch | null>(null);
  if (!prefetchRef.current) {
    prefetchRef.current = new TtsPrefetch((t) => fetchTtsBlob(t));
  }

  // Speak text via TTS (returns a promise that resolves when done speaking)
  const speak = useCallback(async (text: string, signal?: AbortSignal): Promise<void> => {
    return new Promise<void>(async (resolve) => {
      // If already aborted before we start, bail out
      if (signal?.aborted) { resolve(); return; }

      // Respect interrupt backoff — don't start speaking if user just interrupted
      const store = useAudioStore.getState();
      if (store.isInBackoff()) {
        // Wait for backoff to expire
        const remaining = store.interruptBackoffUntil - Date.now();
        if (remaining > 0) {
          await new Promise(r => setTimeout(r, remaining));
          if (signal?.aborted) { resolve(); return; }
        }
      }

      // Never start a clip while the user holds the floor. All three
      // speech lanes (phase boilerplate, stream drain, greetings) funnel
      // through here, so this one gate covers them all.
      await awaitFloorOpen(signal);
      if (signal?.aborted) { resolve(); return; }

      // Self-echo defense: remember what we're about to say so the mic
      // hearing it back gets content-matched and dropped, regardless of
      // timing windows.
      useAudioStore.getState().recordSpokenText(text);

      setPlaying(true);
      // Create a temporary NarrationSegment for display
      const tempSegment: NarrationSegment = {
        id: 'narration-' + Date.now(),
        areaId: '',
        index: 0,
        text,
        visualCue: { type: 'none' },
      };
      setCurrentSegment(tempSegment);

      const cleanup = () => {
        setPlaying(false);
        resolve();
      };

      // Wire up abort handling
      if (signal) {
        signal.addEventListener('abort', () => {
          if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.src = '';
          }
          if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
          }
          cleanup();
        }, { once: true });
      }

      if (ttsProvider === 'openai') {
        // Pipelined: if the drain loop already synthesized this sentence while
        // the previous one played, take that blob and play with ZERO wait.
        const pre = prefetchRef.current?.take(text) ?? null;
        let blob = pre ? await pre : null;
        if (signal?.aborted) { cleanup(); return; }
        // Prefetch miss, OR a prefetch whose synth failed earlier (resolved
        // null) — synthesize on demand now so a transient hiccup at prefetch
        // time doesn't skip straight to browser TTS. null → browser fallback.
        if (!blob) blob = await fetchTtsBlob(text, signal);
        if (signal?.aborted) { cleanup(); return; }
        if (blob) {
          const url = URL.createObjectURL(blob);
          if (!audioRef.current) {
            audioRef.current = new Audio();
            useAudioStore.getState().setAudioElement(audioRef.current);
          }
          audioRef.current.src = url;
          audioRef.current.onended = () => {
            URL.revokeObjectURL(url);
            cleanup();
          };
          audioRef.current.onerror = () => {
            URL.revokeObjectURL(url);
            cleanup();
          };
          audioRef.current.play().catch(() => { cleanup(); });
          return;
        }
        // blob === null → synthesis unavailable; fall through to browser TTS.
        // Tell the user ONCE — the voice quality just dropped audibly and
        // a silent downgrade reads as "the product got worse for no reason".
        if (!ttsDowngradeNotifiedRef.current) {
          ttsDowngradeNotifiedRef.current = true;
          useAudioStore.getState().addSpeechToast('High-quality voice unavailable — using the browser voice for now.', 'status');
        }
      }

      // Browser TTS fallback
      if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;
        utterance.onend = () => { cleanup(); };
        utterance.onerror = () => { cleanup(); };
        speechSynthesis.speak(utterance);
      } else {
        // No TTS available — just wait briefly so user can read the subtitle
        setTimeout(() => { cleanup(); }, Math.max(3000, text.length * 50));
      }
    });
  }, [ttsProvider, setCurrentSegment, setPlaying, awaitFloorOpen, fetchTtsBlob]);

  // SINGLE SERIALIZED SPEECH QUEUE: every lane (phase boilerplate, streamed
  // chunks, greetings) speaks through this tail, so two lanes can never
  // drive the audio element at the same time. Before this, the three
  // independent speak() entry points raced — e.g. the proposal talking over
  // the still-playing opener. An aborted entry resolves as a no-op without
  // blocking the entries behind it.
  const speechTailRef = useRef<Promise<void>>(Promise.resolve());
  const speakSerialized = useCallback((text: string, signal?: AbortSignal): Promise<void> => {
    const run = () => (signal?.aborted ? Promise.resolve() : speak(text, signal));
    const next = speechTailRef.current.then(run, run);
    // The tail must never stay rejected or the queue would stall forever.
    speechTailRef.current = next.catch(() => {});
    return next;
  }, [speak]);

  // Auto-advance: send next command after a short pause. Never fires while
  // the user holds the floor — advancing mid-speech starts new narration
  // right into the user's sentence; it re-arms instead.
  const scheduleAdvance = useCallback((delayMs: number = 800) => {
    if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);
    const fire = () => {
      if (useAudioStore.getState().userHasFloor) {
        autoAdvanceTimerRef.current = setTimeout(fire, 500);
        return;
      }
      sendEvent({ type: 'command:next' });
    };
    autoAdvanceTimerRef.current = setTimeout(fire, delayMs);
  }, []);

  // A hard flush (PTT / confirmed barge-in) must deterministically resolve
  // the in-flight speak() promise: pause()+seek on a hard-stopped element
  // doesn't reliably fire `ended`, which used to leave the serialized
  // speech tail (and the drain loop's await) pending forever. The flush
  // also kills the stale unspoken backlog — the user talked over it.
  const flushEpoch = useAudioStore(s => s.flushEpoch);
  useEffect(() => {
    if (flushEpoch === 0) return;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    activeRunRef.current = '';
    useSessionStore.setState({ streamChunks: [] });
    // The stale backlog is dead — drop any prefetched audio for it.
    prefetchRef.current?.clear();
  }, [flushEpoch]);

  // Floor release on response start: the turn's reply reaching us is the
  // signal that the barge-in exchange completed — narration may flow again.
  const streamChunksForFloor = useSessionStore(s => s.streamChunks);
  useEffect(() => {
    const a = useAudioStore.getState();
    if (streamChunksForFloor.length > 0 && a.floorPhase === 'awaiting-response') {
      a.releaseFloor();
    }
  }, [streamChunksForFloor]);

  // When paused, immediately stop everything
  useEffect(() => {
    if (state.paused) {
      // Kill in-flight TTS
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
      }
      // Drop prefetched audio — playback is stopping.
      prefetchRef.current?.clear();
      // Kill auto-advance timers
      if (autoAdvanceTimerRef.current) {
        clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
      if (postAnswerTimerRef.current) {
        clearTimeout(postAnswerTimerRef.current);
        postAnswerTimerRef.current = null;
      }
      setPlaying(false);
      // Pause = full stop: mic gets torn down in useVoiceInput, the orb shows
      // 'idle' so the user knows nothing is being captured.
      useAudioStore.getState().setVoiceState('idle');
      // Clear the active run so resume can re-trigger
      activeRunRef.current = '';
    }
  }, [state.paused, setPlaying]);

  // Main orchestration: react to phase and segment changes
  useEffect(() => {
    const { phase, areaIndex, segmentIndex, paused } = state;

    // Don't do anything if paused
    if (paused) return;

    // Don't re-trigger for the same state
    const stateKey = `${phase}-${areaIndex ?? -1}-${segmentIndex ?? -1}`;
    if (stateKey === activeRunRef.current) return;

    // Silent phases: this effect doesn't speak or schedule, so leave any
    // in-flight narration (e.g. a greeting) alone. Aborting abortRef here
    // cut the greeting off mid-word whenever analysis completed and the
    // phase flipped to OVERVIEW-explore. That was the self-interrupt.
    // PROPOSAL is silent too: the backend narrates the proposal through
    // the open narration stream (session:proposal.narrated) — the old
    // client-side speak() here talked over the still-playing opener, and
    // its 10s auto-accept closed the window before the user could answer.
    // The session now waits indefinitely; the user steers.
    const isSilentPhase =
      phase === 'ANALYZING' ||
      phase === 'PROPOSAL' ||
      (phase === 'OVERVIEW' && entryMode === 'explore');
    if (isSilentPhase) {
      activeRunRef.current = stateKey;
      lastPhaseRef.current = phase;
      lastAreaIndexRef.current = areaIndex ?? -1;
      lastSegmentIndexRef.current = segmentIndex ?? -1;
      return;
    }

    // Abort any in-flight narration from the previous state
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    activeRunRef.current = stateKey;

    lastPhaseRef.current = phase;
    lastAreaIndexRef.current = areaIndex ?? -1;
    lastSegmentIndexRef.current = segmentIndex ?? -1;

    // Handle each phase
    (async () => {
      const signal = controller.signal;

      switch (phase) {
        case 'PREVIOUSLY_ON': {
          // The recap is backend-narrated (session:recap card + stream
          // chunks) — speaking it here double-voiced it. Advance once the
          // stream drains (see the drain-complete effect below); this
          // schedule is only the no-narration fallback.
          if (!modes.narration) scheduleAdvance(500);
          break;
        }

        case 'HEATMAP': {
          if (modes.narration) {
            const heatmap = useSessionStore.getState().heatmap;
            const total = heatmap?.entries.length ?? 0;
            const green = heatmap?.entries.filter(e => e.status === 'green').length ?? 0;
            const red = heatmap?.entries.filter(e => e.status === 'red').length ?? 0;
            if (total > 0) {
              await speakSerialized(
                `Here's your understanding map. You're familiar with ${green} out of ${total} files. ${red} file${red !== 1 ? 's' : ''} haven't been reviewed yet. Let me show you what changed.`,
                signal,
              );
            }
          }
          if (signal.aborted) return;
          // Auto-advance to overview
          scheduleAdvance(500);
          break;
        }

        case 'PROJECT_OVERVIEW': {
          if (modes.narration) {
            const storeAreas = useSessionStore.getState().areas;
            const areaCount = storeAreas.length;
            const intro = areaCount > 0
              ? `Let me introduce you to this project. I've identified ${areaCount} key areas to explore.`
              : `Let me introduce you to this project.`;
            await speakSerialized(intro, signal);
            if (signal.aborted) return;

            // Show conceptual flow (layer 2) briefly before advancing
            const conceptualSteps = useSessionStore.getState().conceptualSteps;
            if (conceptualSteps.length > 0) {
              useSessionStore.setState({ visualLayer: 2 });
              await speakSerialized("Here's how it works at a high level.", signal);
              if (signal.aborted) return;
              // Give time for the animation
              await new Promise(r => setTimeout(r, 2000));
              if (signal.aborted) return;
            }
          }
          scheduleAdvance(500);
          break;
        }

        case 'ARCHITECTURE_OVERVIEW': {
          if (modes.narration) {
            const storeAreas = useSessionStore.getState().areas;
            const areaNames = storeAreas.slice(0, 3).map(a => a.name).join(', ');
            const archText = storeAreas.length > 0
              ? `Now let's look at the architecture. The main areas are ${areaNames}. I'll walk you through each one.`
              : `Now let's look at how the codebase is organized.`;
            await speakSerialized(archText, signal);
          }
          if (signal.aborted) return;
          scheduleAdvance(500);
          break;
        }

        case 'COMPONENT_TOUR': {
          const ai = areaIndex ?? 0;
          const si = segmentIndex ?? 0;
          const area = areas[ai];
          if (!area) break;

          if (si === 0 && modes.narration) {
            const areaIntro = `Now exploring: ${area.name}. ${area.description}`;
            await speakSerialized(areaIntro, signal);
            if (signal.aborted) return;
          }

          const segment = area.narrationSegments?.[si];
          if (segment && modes.narration) {
            setCurrentSegment(segment);
            await speakSerialized(segment.text, signal);
            if (signal.aborted) return;
            scheduleAdvance(600);
          } else if (!segment) {
            scheduleAdvance(2000);
          }
          break;
        }

        case 'OVERVIEW': {
          if (entryMode === 'explore') {
            // Explore mode: don't auto-advance. User leads.
            break;
          }
          if (modes.narration && areas.length > 0) {
            const areaNames = areas.slice(0, 3).map(a => a.name).join(', ');
            const greeting = areas.length === 1
              ? `I found one area of change: ${areaNames}. Let me walk you through it.`
              : `I found ${areas.length} areas of change. The main ones are ${areaNames}. Let's dive in.`;
            await speakSerialized(greeting, signal);
          }
          if (signal.aborted) return;
          // Auto-advance to first area
          scheduleAdvance(500);
          break;
        }

        case 'AREA_WALKTHROUGH': {
          const ai = areaIndex ?? 0;
          const si = segmentIndex ?? 0;
          const area = areas[ai];
          if (!area) break;

          // If entering a new area (segment 0), announce it
          if (si === 0 && modes.narration) {
            const areaIntro = `Now looking at: ${area.name}. ${area.description}`;
            await speakSerialized(areaIntro, signal);
            if (signal.aborted) return;
          }

          // Play the current narration segment
          const segment = area.narrationSegments?.[si];
          if (segment && modes.narration) {
            setCurrentSegment(segment);
            await speakSerialized(segment.text, signal);
            if (signal.aborted) return;
            // After segment finishes, auto-advance to next
            scheduleAdvance(600);
          } else if (!segment) {
            // No segments left for this area — auto-advance
            scheduleAdvance(2000);
          }
          break;
        }

        case 'AREA_TRANSITION': {
          // Brief pause then auto-advance
          scheduleAdvance(300);
          break;
        }

        case 'ADVISORY': {
          const concerns = useSessionStore.getState().concerns;
          if (concerns.length > 0 && modes.narration) {
            const critical = concerns.filter(c => c.severity === 'critical').length;
            const summary = critical > 0
              ? `I flagged ${concerns.length} observations, including ${critical} critical issue${critical > 1 ? 's' : ''}. Let me highlight them.`
              : `I have ${concerns.length} observation${concerns.length > 1 ? 's' : ''} to share.`;
            await speakSerialized(summary, signal);
          }
          // Let user review concerns — don't auto-advance from here
          break;
        }

        case 'WRAP_UP': {
          if (modes.narration) {
            await speakSerialized(
              `That's everything for this session. You can export a summary for your team, or head back to the lobby.`,
              signal,
            );
          }
          break;
        }
      }
    })();

    // Cleanup timers when dependencies change (before next run)
    return () => {
      if (autoAdvanceTimerRef.current) {
        clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, [state.phase, state.areaIndex, state.segmentIndex, state.paused, areas, entryMode, modes.narration, speak, scheduleAdvance, setCurrentSegment]);

  // Stream chunk player: drains streamChunks one at a time, awaiting each
  // speak() to keep playback strictly in order. The first chunk's TTS
  // request fires immediately on receipt, so the user hears the start of
  // the answer while later chunks are still TTS-generating in parallel
  // (the OpenAI TTS endpoint handles each chunk independently).
  const streamChunks = useSessionStore(s => s.streamChunks);
  const streamPlayingRef = useRef(false);
  useEffect(() => {
    if (streamPlayingRef.current) return; // a drain loop is already running
    if (streamChunks.length === 0) return;
    if (state.paused) return;
    if (!modes.narration) return;
    streamPlayingRef.current = true;

    (async () => {
      try {
        // Cancel any unrelated in-flight narration so the streamed answer
        // takes the floor cleanly. New AbortController lives for the
        // whole drain.
        if (abortRef.current) abortRef.current.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        activeRunRef.current = '';

        while (true) {
          // Freeze BEFORE consuming: chunks must not be popped (and
          // orphaned) while the user holds the floor. speak() gates too,
          // but consuming here first would lose the chunk on abort.
          if (useAudioStore.getState().userHasFloor) {
            await awaitFloorOpen(controller.signal);
          }
          if (controller.signal.aborted) return;
          const next = useSessionStore.getState().consumeStreamChunk();
          if (!next) break;
          // Pipeline: kick off synthesis for the next 1-2 queued sentences
          // WHILE this one plays, so the queue never waits on a round-trip.
          // Fetch-only (no playback) → independent of the floor gate.
          if (useSettingsStore.getState().settings.ttsProvider === 'openai' && prefetchRef.current) {
            for (const c of useSessionStore.getState().streamChunks.slice(0, PREFETCH_AHEAD)) {
              prefetchRef.current.ensure(c.text);
            }
          }
          await speakSerialized(next.text, controller.signal);
          if (controller.signal.aborted) return;
        }
        // Drain-complete: in PREVIOUSLY_ON the recap is backend-streamed;
        // advance only after the user actually heard it all.
        const st = useSessionStore.getState();
        if (st.streamingFinal && st.streamChunks.length === 0 && st.state.phase === 'PREVIOUSLY_ON') {
          scheduleAdvance(500);
        }
      } finally {
        streamPlayingRef.current = false;
      }
    })();
  }, [streamChunks, state.paused, modes.narration, speakSerialized, scheduleAdvance, awaitFloorOpen]);

  // Speak greeting/answer whenever it changes — but COALESCE rapid-fire
  // greetings so we don't cut ourselves off mid-word. Pattern: two greetings
  // arriving within 250ms of each other means the backend is emitting a
  // multi-step sequence ("Welcome…" + "Go ahead." on explore start); we should
  // speak only the FINAL one in the burst, not play all of them abruptly
  // interleaved. Longer gaps (>250ms) are treated as genuine new messages
  // that should interrupt.
  const greeting = useSessionStore(s => s.greeting);
  const greetingSpokenRef = useRef<string>('');
  const greetingPhaseRef = useRef<string>('');
  const greetingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const greetingPendingRef = useRef<{ text: string; briefingId: string | null } | null>(null);

  useEffect(() => {
    if (!greeting || greeting.text === greetingSpokenRef.current) return;
    if (state.phase === 'IDLE') return;
    if (state.paused) return;
    if (!modes.narration) return;

    // Some turn replies arrive as a greeting (one-chunk narrations fall
    // back to narration:greeting) — that's still "the response started",
    // so a floor held for the turn opens here too.
    {
      const a = useAudioStore.getState();
      if (a.floorPhase === 'awaiting-response') a.releaseFloor();
    }

    // Coalescing window: stash the latest greeting, only speak after 250ms
    // of stability. Rapid-fire sequence → last one wins, no audible stutter.
    greetingPendingRef.current = greeting;
    if (greetingDebounceRef.current) clearTimeout(greetingDebounceRef.current);
    greetingDebounceRef.current = setTimeout(() => {
      const latest = greetingPendingRef.current;
      if (!latest || latest.text === greetingSpokenRef.current) return;

      const isQaAnswer = greetingPhaseRef.current === state.phase && greetingSpokenRef.current !== '';
      greetingSpokenRef.current = latest.text;
      greetingPhaseRef.current = state.phase;

      // Only abort if we've already been speaking for >400ms (long enough
      // that interrupting is meaningful rather than destructive).
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      activeRunRef.current = '';

      speakSerialized(latest.text, controller.signal).then(() => {
        if (controller.signal.aborted) return;
        // Seen% fix: briefings are spoken through THIS greeting path, but
        // nothing ever reported playback completion — markSeen() on the
        // backend was dead code in production and "Seen" sat at 0% for whole
        // sessions. The old check matched the SPOKEN text against
        // currentBriefing.text, which diverges on abbreviated openers
        // ("Picking up where we left off.") — so it never fired live. Now the
        // greeting carries its own briefingId; credit by id, no text match.
        // Guarded to non-walkthrough phases: handleSegmentFinished also
        // auto-advances tours.
        const phaseNow = useSessionStore.getState().state.phase;
        if (
          latest.briefingId != null &&
          phaseNow !== 'AREA_WALKTHROUGH' &&
          phaseNow !== 'COMPONENT_TOUR'
        ) {
          sendEvent({ type: 'audio:segment_finished', payload: { segmentId: latest.briefingId } });
        }
        if (isQaAnswer) {
          if (postAnswerTimerRef.current) clearTimeout(postAnswerTimerRef.current);
          postAnswerTimerRef.current = setTimeout(() => {
            const currentState = useSessionStore.getState().state;
            if (currentState.paused) {
              sendEvent({ type: 'command:resume' });
            }
          }, 5000);
        }
      });
    }, 250);

    return () => {
      // cleanup on re-render
    };
  }, [greeting, state.phase, state.paused, modes.narration, speak]);

  // Cancel post-answer auto-resume when user starts speaking (voiceState becomes 'hearing')
  const voiceState = useAudioStore(s => s.voiceState);
  const speechToasts = useAudioStore(s => s.speechToasts);
  useEffect(() => {
    if (voiceState === 'hearing' && postAnswerTimerRef.current) {
      clearTimeout(postAnswerTimerRef.current);
      postAnswerTimerRef.current = null;
    }
  }, [voiceState]);

  // Also cancel if a new speech toast appears (user spoke)
  useEffect(() => {
    if (speechToasts.length > 0 && postAnswerTimerRef.current) {
      clearTimeout(postAnswerTimerRef.current);
      postAnswerTimerRef.current = null;
    }
  }, [speechToasts]);

  // Reset tracking when session goes back to IDLE
  useEffect(() => {
    if (state.phase === 'IDLE') {
      activeRunRef.current = '';
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (postAnswerTimerRef.current) {
        clearTimeout(postAnswerTimerRef.current);
        postAnswerTimerRef.current = null;
      }
      clearQueue();
    }
  }, [state.phase, clearQueue]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
      }
      if (autoAdvanceTimerRef.current) {
        clearTimeout(autoAdvanceTimerRef.current);
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
      if (postAnswerTimerRef.current) {
        clearTimeout(postAnswerTimerRef.current);
      }
    };
  }, []);
}

import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../state/session-store.js';
import { useAudioStore } from '../state/audio-store.js';
import { useSettingsStore } from '../state/settings-store.js';
import { sendEvent } from '../lib/ws-client.js';
import type { NarrationSegment } from '@interactive-reviewer/shared';
import { API_PREFIX } from '@interactive-reviewer/shared';

export function useSessionOrchestrator() {
  const state = useSessionStore(s => s.state);
  const areas = useSessionStore(s => s.areas);
  const modes = useSettingsStore(s => s.modes);
  const { setCurrentSegment, setPlaying, clearQueue } = useAudioStore();
  const ttsProvider = useSettingsStore(s => s.settings.ttsProvider);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastPhaseRef = useRef<string>('IDLE');
  const lastAreaIndexRef = useRef<number>(-1);
  const lastSegmentIndexRef = useRef<number>(-1);
  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against the effect firing multiple times for the same state
  const activeRunRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Speak text via TTS (returns a promise that resolves when done speaking)
  const speak = useCallback(async (text: string, signal?: AbortSignal): Promise<void> => {
    return new Promise<void>(async (resolve) => {
      // If already aborted before we start, bail out
      if (signal?.aborted) { resolve(); return; }

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
        try {
          const res = await fetch(`${API_PREFIX}/audio/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
            signal,
          });
          if (res.ok) {
            const blob = await res.blob();
            if (signal?.aborted) { cleanup(); return; }
            const url = URL.createObjectURL(blob);
            if (!audioRef.current) audioRef.current = new Audio();
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
        } catch {
          if (signal?.aborted) { cleanup(); return; }
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
  }, [ttsProvider, setCurrentSegment, setPlaying]);

  // Auto-advance: send next command after a short pause
  const scheduleAdvance = useCallback((delayMs: number = 800) => {
    if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);
    autoAdvanceTimerRef.current = setTimeout(() => {
      sendEvent({ type: 'command:next' });
    }, delayMs);
  }, []);

  // Main orchestration: react to phase and segment changes
  useEffect(() => {
    const { phase, areaIndex, segmentIndex, paused } = state;

    // Don't do anything if paused
    if (paused) return;

    // Don't re-trigger for the same state
    const stateKey = `${phase}-${areaIndex ?? -1}-${segmentIndex ?? -1}`;
    if (stateKey === activeRunRef.current) return;

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
        case 'ANALYZING': {
          // Speak the greeting if available
          const greeting = useSessionStore.getState().greeting;
          if (greeting && modes.narration) {
            await speak(greeting, signal);
          }
          break;
        }

        case 'PREVIOUSLY_ON': {
          const recap = useSessionStore.getState().recap;
          if (recap && modes.narration) {
            await speak(recap, signal);
          }
          if (signal.aborted) return;
          // Auto-advance to heatmap
          scheduleAdvance(500);
          break;
        }

        case 'HEATMAP': {
          if (modes.narration) {
            const heatmap = useSessionStore.getState().heatmap;
            const total = heatmap?.entries.length ?? 0;
            const green = heatmap?.entries.filter(e => e.status === 'green').length ?? 0;
            const red = heatmap?.entries.filter(e => e.status === 'red').length ?? 0;
            if (total > 0) {
              await speak(
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
            // The project overview narration text comes from the greeting or is generated
            const storeAreas = useSessionStore.getState().areas;
            const areaCount = storeAreas.length;
            const intro = areaCount > 0
              ? `Let me introduce you to this project. I've identified ${areaCount} key areas to explore. Let's start with a high-level overview.`
              : `Let me introduce you to this project. Let's start with a high-level overview.`;
            await speak(intro, signal);
          }
          if (signal.aborted) return;
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
            await speak(archText, signal);
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
            await speak(areaIntro, signal);
            if (signal.aborted) return;
          }

          const segment = area.narrationSegments?.[si];
          if (segment && modes.narration) {
            setCurrentSegment(segment);
            await speak(segment.text, signal);
            if (signal.aborted) return;
            scheduleAdvance(600);
          } else if (!segment) {
            scheduleAdvance(2000);
          }
          break;
        }

        case 'OVERVIEW': {
          if (modes.narration && areas.length > 0) {
            const areaNames = areas.slice(0, 3).map(a => a.name).join(', ');
            const greeting = areas.length === 1
              ? `I found one area of change: ${areaNames}. Let me walk you through it.`
              : `I found ${areas.length} areas of change. The main ones are ${areaNames}. Let's dive in.`;
            await speak(greeting, signal);
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
            await speak(areaIntro, signal);
            if (signal.aborted) return;
          }

          // Play the current narration segment
          const segment = area.narrationSegments?.[si];
          if (segment && modes.narration) {
            setCurrentSegment(segment);
            await speak(segment.text, signal);
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
            await speak(summary, signal);
          }
          // Let user review concerns — don't auto-advance from here
          break;
        }

        case 'WRAP_UP': {
          if (modes.narration) {
            await speak(
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
  }, [state.phase, state.areaIndex, state.segmentIndex, state.paused, areas, modes.narration, speak, scheduleAdvance, setCurrentSegment]);

  // 20-second silence rule
  const resetSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    // Only run silence timer when in a session and not analyzing
    const currentPhase = useSessionStore.getState().state.phase;
    if (currentPhase === 'IDLE' || currentPhase === 'ANALYZING') return;

    silenceTimerRef.current = setTimeout(() => {
      // Canned response - no API call
      const phase = useSessionStore.getState().state.phase;
      if (phase !== 'IDLE' && phase !== 'ANALYZING') {
        speak("Want to keep exploring, or shall I continue the walkthrough?");
      }
    }, 20000);
  }, [speak]);

  // Reset silence timer on any user interaction
  useEffect(() => {
    const handleInteraction = () => resetSilenceTimer();
    window.addEventListener('keydown', handleInteraction);
    window.addEventListener('click', handleInteraction);
    window.addEventListener('touchstart', handleInteraction);

    return () => {
      window.removeEventListener('keydown', handleInteraction);
      window.removeEventListener('click', handleInteraction);
      window.removeEventListener('touchstart', handleInteraction);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, [resetSilenceTimer]);

  // Also reset when phase changes (new narration started)
  useEffect(() => {
    resetSilenceTimer();
  }, [state.phase, state.areaIndex, state.segmentIndex, resetSilenceTimer]);

  // Reset tracking when session goes back to IDLE
  useEffect(() => {
    if (state.phase === 'IDLE') {
      activeRunRef.current = '';
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
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
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
    };
  }, []);
}

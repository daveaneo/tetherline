/**
 * Listening pill — appears at the bottom-center of the viewport whenever
 * the user is holding spacebar (PTT). Gives the user a visible signal
 * that:
 *   • the system actually heard them press space,
 *   • the mic is currently capturing,
 *   • how long they've been holding (so a 15s reflective pause feels
 *     intentional instead of "did the system freeze?").
 *
 * Without this, holding space for several seconds with no visual
 * feedback reads as "nothing is happening." The pill makes the capture
 * state honest.
 */
import { useEffect, useState } from 'react';
import { useAudioStore } from '../../state/audio-store.js';

export function ListeningPill() {
  const startedAt = useAudioStore(s => s.pttHoldStartedAt);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Update the elapsed counter every 250ms while the user is holding.
  // 250ms is fast enough to feel live (smooth seconds rollover) without
  // burning render cycles.
  useEffect(() => {
    if (startedAt == null) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Date.now() - startedAt);
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => clearInterval(interval);
  }, [startedAt]);

  if (startedAt == null) return null;

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="listening-pill"
      style={{
        position: 'fixed',
        bottom: 96,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 16px',
        borderRadius: 999,
        background: 'color-mix(in oklch, var(--sig-okay, oklch(0.72 0.12 145)) 18%, oklch(0.16 0.014 60))',
        border: '1px solid color-mix(in oklch, var(--sig-okay, oklch(0.72 0.12 145)) 35%, transparent)',
        boxShadow: '0 4px 16px oklch(0 0 0 / 0.4)',
        color: 'var(--cream-100, #f4ebe1)',
        fontFamily: 'var(--mono, "Geist Mono", ui-monospace, monospace)',
        fontSize: 13,
        letterSpacing: '0.05em',
        pointerEvents: 'none',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 9, height: 9, borderRadius: '50%',
          background: 'var(--sig-okay, oklch(0.72 0.12 145))',
          boxShadow: '0 0 8px var(--sig-okay, oklch(0.72 0.12 145))',
          animation: 'listening-pill-pulse 1.2s ease-in-out infinite',
        }}
      />
      <span>Listening · {mm}:{ss}</span>
      <style>{`
        @keyframes listening-pill-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.55; transform: scale(0.78); }
        }
      `}</style>
    </div>
  );
}

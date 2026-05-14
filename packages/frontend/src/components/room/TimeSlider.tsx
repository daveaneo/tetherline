/**
 * TimeSlider — scrub through turn snapshots to rewind the visual state
 * of the conversation. Each turn (user-question → AI-answer pair) is
 * a tick on the slider; dragging back rehydrates the diagram to that
 * point. The "time scrubber for your understanding" from the design jam.
 *
 * v1 scope:
 *   - Renders only when there are 2+ turns (no point on turn 1).
 *   - Tick per turn, hover shows a tooltip with question preview.
 *   - Click a tick → fires a custom event the diagram listens for to
 *     scope-rehydrate. (Future: also restore highlight state, etc.)
 *   - "Live" position at the rightmost tick (most recent turn).
 *
 * Lives at the bottom of the diagram canvas, low visual weight by
 * default (subtle line + ticks); brightens on hover.
 */
import { useState } from 'react';
import { useSessionStore } from '../../state/session-store.js';

export function TimeSlider({ onRehydrateScope }: { onRehydrateScope?: (scope: string) => void }) {
  const turnSnapshots = useSessionStore(s => s.turnSnapshots);
  const [hovered, setHovered] = useState<number | null>(null);

  if (turnSnapshots.length < 2) return null;

  return (
    <div
      role="slider"
      aria-label="Conversation timeline — drag to rewind diagram state"
      aria-valuemin={0}
      aria-valuemax={turnSnapshots.length - 1}
      aria-valuenow={turnSnapshots.length - 1}
      data-testid="time-slider"
      style={{
        position: 'absolute',
        left: 32,
        right: 32,
        bottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        pointerEvents: 'none', // children re-enable
      }}
    >
      {/* Hover tooltip */}
      {hovered !== null && (
        <div
          style={{
            alignSelf: 'center',
            padding: '6px 10px',
            borderRadius: 6,
            background: 'oklch(0.18 0.012 60 / 0.94)',
            border: '1px solid oklch(1 0 0 / 0.08)',
            color: 'var(--cream-200, #e8dcc8)',
            fontFamily: 'var(--mono, "Geist Mono", ui-monospace, monospace)',
            fontSize: 11,
            maxWidth: 360,
            textAlign: 'center',
            backdropFilter: 'blur(4px)',
            pointerEvents: 'none',
          }}
        >
          turn {hovered + 1} · {turnSnapshots[hovered].question.slice(0, 80) || '(initial)'}
        </div>
      )}

      {/* Track + ticks */}
      <div
        style={{
          position: 'relative',
          height: 18,
          display: 'flex',
          alignItems: 'center',
          pointerEvents: 'auto',
        }}
      >
        {/* Base track */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: 1,
            background: 'oklch(1 0 0 / 0.08)',
          }}
        />
        {/* Ticks */}
        {turnSnapshots.map((turn, i) => {
          const pct = turnSnapshots.length === 1 ? 100 : (i / (turnSnapshots.length - 1)) * 100;
          const isLast = i === turnSnapshots.length - 1;
          const isHover = hovered === i;
          return (
            <button
              key={turn.turnIndex}
              type="button"
              onClick={() => onRehydrateScope?.(turn.scope)}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{
                position: 'absolute',
                left: `${pct}%`,
                transform: 'translateX(-50%)',
                width: isHover || isLast ? 10 : 7,
                height: isHover || isLast ? 10 : 7,
                borderRadius: '50%',
                background: isLast
                  ? 'var(--amber-400, oklch(0.74 0.12 65))'
                  : isHover
                    ? 'var(--cream-200, #e8dcc8)'
                    : 'oklch(0.4 0.03 70)',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                boxShadow: isLast ? '0 0 6px var(--amber-400, oklch(0.74 0.12 65))' : 'none',
                transition: 'all 0.15s ease',
              }}
              title={`turn ${i + 1}: ${turn.question || '(initial)'}`}
              aria-label={`Rewind to turn ${i + 1}`}
              data-testid={`time-tick-${i}`}
            />
          );
        })}
      </div>
    </div>
  );
}

import { useSessionStore } from '../../state/session-store.js';

export interface CritiqueConcern {
  title: string;
  severity: 'high' | 'medium' | 'low';
  targets?: string[];
  detail: string;
}

// Single-hued: "concern" is one colour everywhere; severity reads as
// intensity, not a new hue. Keeps the card honest about what it means.
const SEVERITY_OPACITY: Record<CritiqueConcern['severity'], number> = {
  high: 1,
  medium: 0.62,
  low: 0.34,
};

/** The ranked concern list shared by the drawer (the surface visible
 *  during narrative phases, where critique actually fires) and the
 *  legacy ContentPanel. Clicking a row — or "Next concern" — selects
 *  it: the store re-speaks that concern's detail via the existing
 *  greeting TTS path and the diagram tint moves to its targets. No
 *  extra LLM call, no voice-routing involved. */
export function RankedCritiquePanel({ concerns }: { concerns: CritiqueConcern[] }) {
  const active = useSessionStore(s => s.critiqueActiveIndex);
  const setActive = useSessionStore(s => s.setCritiqueActive);
  const i = Math.max(0, Math.min(active, concerns.length - 1));

  return (
    <div data-testid="critique-concerns">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
          Critique
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {concerns.length} concern{concerns.length === 1 ? '' : 's'} · most serious first
        </span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {concerns.map((c, idx) => {
          const isActive = idx === i;
          return (
            <li key={idx}>
              <button
                onClick={() => setActive(idx)}
                aria-current={isActive}
                className={
                  'w-full text-left rounded-lg px-3 py-2 transition-colors border ' +
                  (isActive
                    ? 'border-[var(--sig-concern)]/55 bg-[var(--sig-concern)]/10'
                    : 'border-transparent hover:bg-[var(--color-text)]/5')
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-label={`${c.severity} severity`}
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 2,
                      background: 'var(--sig-concern)',
                      opacity: SEVERITY_OPACITY[c.severity] ?? 0.62,
                      flexShrink: 0,
                    }}
                  />
                  <span className="text-sm font-medium text-[var(--color-text)] flex-1">
                    {c.title}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                    {c.severity}
                  </span>
                </div>
                {isActive && (
                  <p className="mt-2 text-sm text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">
                    {c.detail}
                  </p>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {concerns.length > 1 && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => setActive(i + 1)}
            disabled={i >= concerns.length - 1}
            className="text-xs px-3 py-1 rounded-full border border-[var(--color-accent)]/40 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:opacity-40 disabled:cursor-default"
          >
            Next concern &#9656;
          </button>
        </div>
      )}
    </div>
  );
}

import { useSession } from '../../hooks/useSession.js';

export function ProgressBar() {
  const { state, context, analysisProgress } = useSession();

  if (state.phase === 'IDLE') return null;

  if (state.phase === 'ANALYZING' && analysisProgress) {
    return (
      <div className="px-6 py-2 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1.5 bg-[var(--color-border)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--color-accent)] rounded-full transition-all duration-500"
              style={{ width: `${analysisProgress.progress * 100}%` }}
            />
          </div>
          <span className="text-xs text-[var(--color-text-muted)]">{analysisProgress.message}</span>
        </div>
      </div>
    );
  }

  if (state.phase === 'AREA_WALKTHROUGH' && state.areaIndex !== undefined) {
    return (
      <div className="px-6 py-2 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--color-text-muted)]">
            Area {state.areaIndex + 1} of {context.totalAreas}
            {state.segmentIndex !== undefined && context.currentAreaSegments
              ? ` · Segment ${state.segmentIndex + 1} of ${context.currentAreaSegments}`
              : ''}
          </span>
        </div>
      </div>
    );
  }

  return null;
}

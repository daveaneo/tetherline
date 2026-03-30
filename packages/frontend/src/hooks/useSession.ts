import { useSessionStore } from '../state/session-store.js';

export function useSession() {
  const state = useSessionStore(s => s.state);
  const context = useSessionStore(s => s.context);
  const areas = useSessionStore(s => s.areas);
  const currentArea = useSessionStore(s =>
    s.state.areaIndex !== undefined ? s.areas[s.state.areaIndex] : undefined
  );
  const analysisProgress = useSessionStore(s => s.analysisProgress);

  return { state, context, areas, currentArea, analysisProgress };
}

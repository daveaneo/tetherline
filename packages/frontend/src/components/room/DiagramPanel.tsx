import { useMemo } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { ArchitectureDiagram } from '../diagrams/ArchitectureDiagram.js';
import { motion, AnimatePresence } from 'framer-motion';

export function DiagramPanel() {
  const { state, areas } = useSession();
  const heatmap = useSessionStore(s => s.heatmap);

  // Collect all nodes and edges from areas
  const { nodes, edges } = useMemo(() => {
    const allNodes = areas.flatMap(a => a.architectureNodes ?? []);
    const allEdges = areas.flatMap(a => a.architectureEdges ?? []);
    return { nodes: allNodes, edges: allEdges };
  }, [areas]);

  // Determine focused node based on current state
  const focusedNodeId = useMemo(() => {
    if (state.phase === 'AREA_WALKTHROUGH' && state.areaIndex !== undefined) {
      const area = areas[state.areaIndex];
      if (area) {
        // Find the segment's visual cue
        const segment = area.narrationSegments?.[state.segmentIndex ?? 0];
        if (segment?.visualCue?.diagramNodeId) {
          return segment.visualCue.diagramNodeId;
        }
      }
    }
    return undefined;
  }, [state, areas]);

  // Highlighted files from current area
  const highlightedFiles = useMemo(() => {
    if (state.phase === 'AREA_WALKTHROUGH' && state.areaIndex !== undefined) {
      return areas[state.areaIndex]?.affectedFiles ?? [];
    }
    return [];
  }, [state, areas]);

  const isAnalyzing = state.phase === 'ANALYZING';
  const hasNodes = nodes.length > 0;

  return (
    <div className="h-full relative">
      <AnimatePresence mode="wait">
        {isAnalyzing && !hasNodes && (
          <motion.div
            key="analyzing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <div className="text-center">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
                className="w-16 h-16 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full mx-auto mb-4"
              />
              <p className="text-sm text-[var(--color-text-muted)]">Building architecture map...</p>
            </div>
          </motion.div>
        )}

        {hasNodes && (
          <motion.div
            key="diagram"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="h-full"
          >
            <ArchitectureDiagram
              nodes={nodes}
              edges={edges}
              focusedNodeId={focusedNodeId}
              highlightedFiles={highlightedFiles}
            />
          </motion.div>
        )}

        {!isAnalyzing && !hasNodes && (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <p className="text-sm text-[var(--color-text-muted)]">Architecture diagram will appear here</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Phase indicator overlay */}
      {state.phase === 'AREA_WALKTHROUGH' && state.areaIndex !== undefined && (
        <div className="absolute top-3 left-3 px-3 py-1.5 bg-[var(--color-surface)]/80 backdrop-blur-sm rounded-lg border border-[var(--color-border)] text-xs">
          <span className="text-[var(--color-text-muted)]">Area {(state.areaIndex ?? 0) + 1} of {areas.length}</span>
          <span className="mx-2 text-[var(--color-border)]">&middot;</span>
          <span className="text-[var(--color-accent)]">{areas[state.areaIndex]?.name}</span>
        </div>
      )}
    </div>
  );
}

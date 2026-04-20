import { useMemo } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { ArchitectureDiagram } from '../diagrams/ArchitectureDiagram.js';
import { BookJacket } from '../layers/BookJacket.js';
import { ConceptualFlow } from '../layers/ConceptualFlow.js';
import { CodeLayer } from '../layers/CodeLayer.js';
import { LayerNav } from './LayerNav.js';
import { LAYER_NAMES, type VisualLayer } from '@interactive-reviewer/shared';
import { motion, AnimatePresence } from 'framer-motion';

export function DiagramPanel() {
  const { state, areas } = useSession();
  const visualLayer = useSessionStore(s => s.visualLayer);

  // Collect all nodes and edges from areas (used by layers 3-4)
  const { nodes, edges } = useMemo(() => {
    const allNodes = areas.flatMap(a => a.architectureNodes ?? []);
    const allEdges = areas.flatMap(a => a.architectureEdges ?? []);
    return { nodes: allNodes, edges: allEdges };
  }, [areas]);

  // Determine focused node based on current state (layers 3-4)
  const focusedNodeId = useMemo(() => {
    if ((visualLayer === 3 || visualLayer === 4) && state.areaIndex !== undefined) {
      const area = areas[state.areaIndex];
      const segment = area?.narrationSegments?.[state.segmentIndex ?? 0];
      return segment?.visualCue?.diagramNodeId;
    }
    return undefined;
  }, [visualLayer, state, areas]);

  // Highlighted files from current area
  const highlightedFiles = useMemo(() => {
    if (state.areaIndex !== undefined) {
      return areas[state.areaIndex]?.affectedFiles ?? [];
    }
    return [];
  }, [state, areas]);

  const isAnalyzing = state.phase === 'ANALYZING';
  const hasNodes = nodes.length > 0;

  return (
    <div className="h-full relative">
      <LayerNav />

      {/* Layer indicator — subtle */}
      <div
        className="absolute top-12 right-3 z-10 kicker"
        style={{
          padding: '4px 10px',
          background: 'color-mix(in oklch, var(--ink-100) 70%, transparent)',
          backdropFilter: 'blur(12px)',
          borderRadius: 'var(--r-pill)',
          border: '1px solid oklch(1 0 0 / 0.05)',
          fontSize: 9.5,
        }}
      >
        {LAYER_NAMES[visualLayer as VisualLayer]}
      </div>

      {/* Area indicator (layers 3+) — subtle */}
      {state.phase !== 'IDLE' && state.areaIndex !== undefined && visualLayer >= 3 && (
        <div
          className="absolute top-12 left-3 z-10 font-mono"
          style={{
            padding: '4px 10px',
            fontSize: 10.5,
            letterSpacing: '0.04em',
            background: 'color-mix(in oklch, var(--ink-100) 70%, transparent)',
            backdropFilter: 'blur(12px)',
            borderRadius: 'var(--r-pill)',
            border: '1px solid oklch(1 0 0 / 0.05)',
          }}
        >
          <span style={{ color: 'var(--cream-500)' }}>
            {(state.areaIndex ?? 0) + 1}/{areas.length}
          </span>
          <span style={{ margin: '0 6px', color: 'oklch(1 0 0 / 0.15)' }}>·</span>
          <span style={{ color: 'var(--amber-400)' }}>{areas[state.areaIndex]?.name}</span>
        </div>
      )}

      <AnimatePresence mode="wait">
        {/* Analyzing spinner — shown when analyzing and no diagram nodes yet */}
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
                className="mx-auto mb-5 rounded-full"
                style={{
                  width: 72, height: 72,
                  border: '1px solid oklch(1 0 0 / 0.06)',
                  borderTopColor: 'var(--amber-400)',
                  boxShadow: '0 0 40px -8px var(--amber-500)',
                }}
              />
              <p className="font-serif" style={{ fontSize: 20, fontStyle: 'italic', color: 'var(--cream-500)' }}>
                Reading your repository…
              </p>
            </div>
          </motion.div>
        )}

        {/* Layer 1: Book Jacket */}
        {!isAnalyzing && visualLayer === 1 && (
          <motion.div
            key="layer-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <BookJacket />
          </motion.div>
        )}

        {/* Layer 2: Conceptual Flow */}
        {!isAnalyzing && visualLayer === 2 && (
          <motion.div
            key="layer-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <ConceptualFlow />
          </motion.div>
        )}

        {/* Layers 3-4: Architecture / Component diagram */}
        {!isAnalyzing && (visualLayer === 3 || visualLayer === 4) && (
          <motion.div
            key={`layer-${visualLayer}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            {hasNodes ? (
              <ArchitectureDiagram
                nodes={nodes}
                edges={edges}
                focusedNodeId={focusedNodeId}
                highlightedFiles={highlightedFiles}
              />
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="font-serif" style={{ fontStyle: 'italic', fontSize: 18, color: 'var(--cream-500)' }}>
                  The architecture diagram will bloom here.
                </p>
              </div>
            )}
          </motion.div>
        )}

        {/* Layer 5: Code */}
        {!isAnalyzing && visualLayer === 5 && (
          <motion.div
            key="layer-5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="h-full"
          >
            <CodeLayer />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { CodeSnippet } from '../code/CodeSnippet.js';
import { DiffView } from '../code/DiffView.js';
import { RankedCritiquePanel, type CritiqueConcern } from './RankedCritique.js';
import { motion, AnimatePresence } from 'framer-motion';

export function ContentDrawer() {
  const { state, areas } = useSession();
  const skillResult = useSessionStore(s => s.skillResult);
  const conversationHistory = useSessionStore(s => s.conversationHistory);
  const [pinned, setPinned] = useState(false);

  const currentArea = state.areaIndex !== undefined ? areas[state.areaIndex] : undefined;
  const currentSegment = currentArea?.narrationSegments?.[state.segmentIndex ?? 0];
  const visualCue = currentSegment?.visualCue;

  // Auto-dismiss skill result after 15 seconds or on phase change (unless pinned)
  useEffect(() => {
    if (!skillResult || pinned) return;
    const timer = setTimeout(() => {
      useSessionStore.setState({ skillResult: null });
    }, 15000);
    return () => clearTimeout(timer);
  }, [skillResult, pinned]);

  useEffect(() => {
    if (pinned) return;
    useSessionStore.setState({ skillResult: null, skillClarification: null });
  }, [state.phase, state.areaIndex, state.segmentIndex, pinned]);

  // Determine if drawer should be open and what to show
  let drawerContent: 'code' | 'diff' | 'skill' | 'conversation' | null = null;

  // Skills that confirm themselves through their OWN surface get no
  // generic drawer card (it would only add a redundant / raw-skill-id
  // "document"): whats_changed → spoken recap + diagram heatmap;
  // grill_me → the calm `?` screen + voice + HermesText Q&A; annotate
  // → spoken "Noted" + the Notebook shelf row + the node pin.
  if (skillResult && !['whats_changed', 'grill_me', 'annotate'].includes(skillResult.skillName)) {
    drawerContent = 'skill';
  } else if (visualCue?.type === 'show_code' && visualCue.code) {
    drawerContent = 'code';
  } else if (visualCue?.type === 'show_diff' && visualCue.filePath) {
    drawerContent = 'diff';
  }

  // Also show if there's a recent conversation entry (Q&A answer)
  const lastConvo = conversationHistory[conversationHistory.length - 1];
  const hasRecentAnswer = lastConvo?.speaker === 'ai' && (Date.now() - lastConvo.timestamp) < 10000;
  if (hasRecentAnswer && !drawerContent) {
    drawerContent = 'conversation';
  }

  const isOpen = drawerContent !== null;

  const handleClose = () => {
    useSessionStore.setState({ skillResult: null });
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="absolute right-0 top-0 bottom-0 w-[42%] max-w-xl bg-[var(--color-surface)]/90 backdrop-blur-xl border-l border-[var(--color-border)] shadow-2xl shadow-black/40 z-20 overflow-y-auto"
        >
          {/* Pin toggle + Close button */}
          <div className="absolute top-3 right-3 z-10 flex gap-1">
            <button
              onClick={() => setPinned(!pinned)}
              className={`w-8 h-8 flex items-center justify-center rounded-full text-sm transition-colors ${
                pinned
                  ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                  : 'bg-[var(--color-bg)]/60 text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }`}
              title={pinned ? 'Unpin drawer' : 'Pin drawer open'}
            >
              &#x1F4CC;
            </button>
            <button
              onClick={() => { setPinned(false); useSessionStore.setState({ skillResult: null }); }}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-[var(--color-bg)]/60 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-sm"
            >
              &#x2715;
            </button>
          </div>

          <div className="p-6 pt-12">
            {drawerContent === 'code' && visualCue && (
              <CodeSnippet
                code={visualCue.code!}
                language={visualCue.language ?? 'text'}
                filePath={visualCue.filePath}
              />
            )}

            {drawerContent === 'diff' && visualCue && (
              <DiffView
                filePath={visualCue.filePath!}
                hunks={[{ content: visualCue.code ?? '' }]}
              />
            )}

            {drawerContent === 'skill' && skillResult && (() => {
              const concerns = skillResult.visualPayload?.concerns as
                | CritiqueConcern[]
                | undefined;
              if (
                skillResult.skillName === 'critique' &&
                Array.isArray(concerns) && concerns.length > 0
              ) {
                return <RankedCritiquePanel concerns={concerns} />;
              }
              return (
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-[var(--color-accent)]">
                    {skillResult.skillName}
                  </h3>
                  <p className="text-sm text-[var(--color-text)] leading-relaxed">
                    {skillResult.narration}
                  </p>
                </div>
              );
            })()}

            {drawerContent === 'conversation' && lastConvo && (
              <div className="space-y-3">
                <p className="text-sm text-[var(--color-text)] leading-relaxed">
                  {lastConvo.text}
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

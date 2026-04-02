import { useEffect } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { CodeSnippet } from '../code/CodeSnippet.js';
import { DiffView } from '../code/DiffView.js';
import { motion, AnimatePresence } from 'framer-motion';

export function ContentDrawer() {
  const { state, areas } = useSession();
  const skillResult = useSessionStore(s => s.skillResult);
  const conversationHistory = useSessionStore(s => s.conversationHistory);

  const currentArea = state.areaIndex !== undefined ? areas[state.areaIndex] : undefined;
  const currentSegment = currentArea?.narrationSegments?.[state.segmentIndex ?? 0];
  const visualCue = currentSegment?.visualCue;

  // Auto-dismiss skill result after 15 seconds or on phase change
  useEffect(() => {
    if (!skillResult) return;
    const timer = setTimeout(() => {
      useSessionStore.setState({ skillResult: null });
    }, 15000);
    return () => clearTimeout(timer);
  }, [skillResult]);

  useEffect(() => {
    useSessionStore.setState({ skillResult: null, skillClarification: null });
  }, [state.phase, state.areaIndex, state.segmentIndex]);

  // Determine if drawer should be open and what to show
  let drawerContent: 'code' | 'diff' | 'skill' | 'conversation' | null = null;

  if (skillResult) {
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
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-[var(--color-bg)]/60 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors text-sm"
          >
            &#x2715;
          </button>

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

            {drawerContent === 'skill' && skillResult && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-[var(--color-accent)]">
                  {skillResult.skillName}
                </h3>
                <p className="text-sm text-[var(--color-text)] leading-relaxed">
                  {skillResult.narration}
                </p>
              </div>
            )}

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

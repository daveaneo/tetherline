import { useAudioStore } from '../../state/audio-store.js';
import { motion, AnimatePresence } from 'framer-motion';

export function NarrationPlayer() {
  const { currentSegment, isPlaying } = useAudioStore();

  if (!currentSegment) return null;

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 max-w-2xl w-full px-4">
      <AnimatePresence mode="wait">
        <motion.div
          key={currentSegment.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="bg-[var(--color-surface)]/90 backdrop-blur-sm border border-[var(--color-border)] rounded-xl px-6 py-4 shadow-2xl"
        >
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-[var(--color-accent)] animate-pulse' : 'bg-[var(--color-text-muted)]'}`} />
            <p className="text-sm text-[var(--color-text)] leading-relaxed">
              {currentSegment.text}
            </p>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

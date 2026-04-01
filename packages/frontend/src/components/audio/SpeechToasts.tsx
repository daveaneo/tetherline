import { useAudioStore } from '../../state/audio-store.js';
import { AnimatePresence, motion } from 'framer-motion';

export function SpeechToasts() {
  const toasts = useAudioStore(s => s.speechToasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-6 z-30 flex flex-col gap-2 max-w-sm">
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, x: 40, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="px-4 py-2.5 rounded-xl bg-[var(--color-surface)] border border-[var(--color-green)]/30 shadow-lg shadow-black/20"
          >
            <div className="flex items-start gap-2.5">
              <span className="text-[var(--color-green)] text-xs mt-0.5 flex-shrink-0">You:</span>
              <p className="text-sm text-[var(--color-text)] leading-relaxed">{toast.text}</p>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

import { useSessionStore } from '../../state/session-store.js';
import { motion, AnimatePresence } from 'framer-motion';

export function ErrorBanner() {
  const error = useSessionStore(s => s.error);
  const clearError = useSessionStore(s => s.clearError);

  return (
    <AnimatePresence>
      {error && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className={`px-6 py-3 flex items-center justify-between ${
            error.recoverable
              ? 'bg-amber-500/10 border-b border-amber-500/30'
              : 'bg-red-500/10 border-b border-red-500/30'
          }`}
        >
          <div className="flex items-center gap-3">
            <span className={`text-sm font-medium ${error.recoverable ? 'text-amber-400' : 'text-red-400'}`}>
              {error.recoverable ? 'Warning' : 'Error'}
            </span>
            <span className="text-sm text-[var(--color-text)]">{error.message}</span>
          </div>
          <button
            onClick={clearError}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            Dismiss
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

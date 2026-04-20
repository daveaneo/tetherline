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
          style={{
            padding: '12px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: error.recoverable
              ? 'color-mix(in oklch, var(--sig-concern) 10%, transparent)'
              : 'color-mix(in oklch, var(--sig-break) 10%, transparent)',
            borderBottom: `1px solid color-mix(in oklch, ${error.recoverable ? 'var(--sig-concern)' : 'var(--sig-break)'} 30%, transparent)`,
          }}
        >
          <div className="flex items-center gap-3">
            <span
              className="font-mono"
              style={{
                fontSize: 10.5,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: error.recoverable ? 'var(--sig-concern)' : 'var(--sig-break)',
              }}
            >
              {error.recoverable ? 'Warning' : 'Error'}
            </span>
            <span style={{ fontSize: 14, color: 'var(--cream-800)' }}>{error.message}</span>
          </div>
          <button
            type="button"
            onClick={clearError}
            className="font-mono"
            style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cream-500)' }}
          >
            Dismiss
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

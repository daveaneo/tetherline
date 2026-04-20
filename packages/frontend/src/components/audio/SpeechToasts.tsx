import { useAudioStore } from '../../state/audio-store.js';
import { AnimatePresence, motion } from 'framer-motion';

export function SpeechToasts() {
  const toasts = useAudioStore(s => s.speechToasts);
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-6 z-30 flex flex-col gap-2 max-w-sm pointer-events-none">
      <AnimatePresence>
        {toasts.map(toast => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, x: 40, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.96 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            style={{
              padding: '12px 16px',
              borderRadius: 'var(--r-lg)',
              background: 'color-mix(in oklch, var(--ink-100) 92%, transparent)',
              backdropFilter: 'blur(16px)',
              border: '1px solid color-mix(in oklch, var(--sig-okay) 30%, transparent)',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <div className="flex items-start gap-3">
              <span
                className="font-mono flex-shrink-0"
                style={{
                  fontSize: 10,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: 'var(--sig-okay)',
                  marginTop: 2,
                }}
              >
                You
              </span>
              <p className="font-serif" style={{ fontSize: 15, fontStyle: 'italic', color: 'var(--cream-900)', lineHeight: 1.4, letterSpacing: '-0.005em' }}>
                {toast.text}
              </p>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

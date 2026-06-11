import { useAudioStore, type SpeechToastKind } from '../../state/audio-store.js';
import { AnimatePresence, motion } from 'framer-motion';

/** Per-kind chrome: a user transcript reads as a quote ("You" + italic
 *  serif); system status and errors read as machine lines (mono label +
 *  upright text) so they can never be mistaken for something the user
 *  said. */
const KIND_STYLE: Record<SpeechToastKind, { label: string; accent: string; border: string }> = {
  transcript: { label: 'You', accent: 'var(--sig-okay)', border: 'color-mix(in oklch, var(--sig-okay) 30%, transparent)' },
  status: { label: 'System', accent: 'var(--cream-500)', border: 'oklch(1 0 0 / 0.10)' },
  error: { label: 'Problem', accent: 'var(--sig-break)', border: 'color-mix(in oklch, var(--sig-break) 40%, transparent)' },
};

export function SpeechToasts() {
  const toasts = useAudioStore(s => s.speechToasts);
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-6 z-30 flex flex-col gap-2 max-w-sm pointer-events-none">
      <AnimatePresence>
        {toasts.map(toast => {
          const k = KIND_STYLE[toast.kind] ?? KIND_STYLE.transcript;
          const isQuote = toast.kind === 'transcript';
          return (
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
                border: `1px solid ${k.border}`,
                boxShadow: 'var(--shadow-2)',
              }}
              data-toast-kind={toast.kind}
            >
              <div className="flex items-start gap-3">
                <span
                  className="font-mono flex-shrink-0"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: k.accent,
                    marginTop: 2,
                  }}
                >
                  {k.label}
                </span>
                {isQuote ? (
                  <p className="font-serif" style={{ fontSize: 15, fontStyle: 'italic', color: 'var(--cream-900)', lineHeight: 1.4, letterSpacing: '-0.005em' }}>
                    {toast.text}
                  </p>
                ) : (
                  <p className="font-mono" style={{ fontSize: 12.5, color: toast.kind === 'error' ? 'var(--cream-800)' : 'var(--cream-600)', lineHeight: 1.45 }}>
                    {toast.text}
                  </p>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

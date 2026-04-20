import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';

const MODE_LABELS: Record<string, string> = {
  full_walkthrough: 'Full walkthrough',
  updates: 'Updates only',
  onboarding: 'Onboarding program',
  explore: 'Free exploration',
};

export function SessionEntrance({ onComplete }: { onComplete: () => void }) {
  const [visible, setVisible] = useState(true);
  const entryMode = useSessionStore(s => s.entryMode);
  const greeting = useSessionStore(s => s.greeting);

  const nameMatch = greeting?.match(/(?:to|at|in)\s+(\S+)/i);
  const projectName = nameMatch?.[1] ?? 'your project';

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onComplete, 500);
    }, 3000);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center"
          style={{
            background:
              'radial-gradient(ellipse at center, oklch(0.18 0.017 55) 0%, var(--ink-050) 70%)',
          }}
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.4 }}
            className="kicker"
          >
            Tetherline
          </motion.div>

          <motion.h1
            initial={{ scale: 0.94, opacity: 0, letterSpacing: '0em' }}
            animate={{ scale: 1, opacity: 1, letterSpacing: '-0.03em' }}
            transition={{ delay: 0.3, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="font-serif text-center mt-4"
            style={{
              fontSize: 'clamp(48px, 7vw, 96px)',
              fontWeight: 300,
              lineHeight: 0.98,
              color: 'var(--cream-900)',
            }}
          >
            {projectName}
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.9, duration: 0.5 }}
            className="font-serif mt-4"
            style={{
              fontSize: 22,
              fontStyle: 'italic',
              color: 'var(--amber-400)',
              letterSpacing: '-0.005em',
            }}
          >
            {MODE_LABELS[entryMode] ?? 'Review session'}
          </motion.p>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.7 }}
            transition={{ delay: 1.6, duration: 0.6 }}
            className="font-mono mt-10"
            style={{
              fontSize: 11,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--cream-500)',
            }}
          >
            Just talk to interrupt · anytime
          </motion.p>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2 }}
            className="absolute bottom-12 flex gap-1.5"
          >
            {[0, 1, 2].map(i => (
              <motion.div
                key={i}
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--amber-400)',
                  boxShadow: '0 0 8px var(--amber-400)',
                }}
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
              />
            ))}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

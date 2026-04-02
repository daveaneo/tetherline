import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';

export function SessionEntrance({ onComplete }: { onComplete: () => void }) {
  const [visible, setVisible] = useState(true);
  const entryMode = useSessionStore(s => s.entryMode);
  const greeting = useSessionStore(s => s.greeting);

  // Extract project name from greeting or use fallback
  const nameMatch = greeting?.match(/(?:to|at|in)\s+(\S+)/i);
  const projectName = nameMatch?.[1] ?? 'your project';

  const modeLabels: Record<string, string> = {
    full_walkthrough: 'Full Walkthrough',
    updates: 'Updates Review',
    onboarding: 'Onboarding Program',
    explore: 'Free Exploration',
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onComplete, 500); // wait for exit animation
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
          transition={{ duration: 0.5 }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--color-bg)]"
        >
          <motion.h1
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.6, ease: 'easeOut' }}
            className="text-5xl md:text-7xl font-bold tracking-tight text-[var(--color-text)]"
          >
            {projectName}
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8, duration: 0.4 }}
            className="mt-4 text-lg text-[var(--color-accent)]"
          >
            {modeLabels[entryMode] ?? 'Review Session'}
          </motion.p>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            transition={{ delay: 1.5, duration: 0.5 }}
            className="mt-8 text-sm text-[var(--color-text-muted)]"
          >
            Just talk to interrupt at any time
          </motion.p>

          {/* Subtle loading pulse at bottom */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2 }}
            className="absolute bottom-12"
          >
            <div className="flex gap-1">
              {[0, 1, 2].map(i => (
                <motion.div
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)]"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

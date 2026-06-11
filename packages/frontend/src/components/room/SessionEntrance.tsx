import { useState, useEffect, useCallback } from 'react';
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
  const activeRepoPath = useSessionStore(s => s.activeRepoPath);

  // The project name comes from the repo path the user actually picked —
  // it used to be regex-scraped from the greeting text, which happily
  // rendered "your" as a 96px hero title for "Welcome back to your repo".
  const projectName = activeRepoPath?.split('/').filter(Boolean).pop() ?? 'your project';

  const dismiss = useCallback(() => {
    setVisible(v => {
      if (!v) return v;
      setTimeout(onComplete, 500);
      return false;
    });
  }, [onComplete]);

  // Auto-dismiss after 3s — but the splash is latency theater for a
  // returning user, so any click or keypress skips it immediately.
  // Capture phase + stopPropagation: the skip keystroke must be
  // CONSUMED, not also delivered to the session hotkeys (pressing "s"
  // to skip the splash would otherwise fire command:skip too).
  useEffect(() => {
    const timer = setTimeout(dismiss, 3000);
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [dismiss]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center"
          onClick={dismiss}
          style={{
            cursor: 'pointer',
            background:
              'radial-gradient(ellipse at center, oklch(0.18 0.017 55) 0%, var(--ink-050) 70%)',
          }}
          data-testid="session-entrance"
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

          {/* The one guaranteed-attention onboarding line. It MUST teach
              the real voice model: mic starts OFF, hold space to talk.
              ("Just talk to interrupt" taught a model that fails the
              first time the user tries it.) */}
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
            Hold space to talk · mic starts off
          </motion.p>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2 }}
            className="absolute bottom-12 flex flex-col items-center gap-3"
          >
            <div className="flex gap-1.5">
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
            </div>
            <span
              className="font-mono"
              style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--cream-500)', opacity: 0.6 }}
            >
              click to skip
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

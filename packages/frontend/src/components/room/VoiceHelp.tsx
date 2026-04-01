import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const STORAGE_KEY = 'voice_help_shown';

const HELP_GROUPS = [
  {
    label: 'Navigation',
    commands: ['"next"', '"skip"', '"go back"', '"dive deeper"'],
  },
  {
    label: 'Control',
    commands: ['"pause"', '"resume"', '"mute"', '"exit"'],
  },
  {
    label: 'Questions',
    commands: ['Just ask anything naturally'],
  },
  {
    label: 'Export',
    commands: ['"export slides"', '"export markdown"'],
  },
];

export function VoiceHelp() {
  const [visible, setVisible] = useState(false);

  // Show automatically on first session
  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true);
      localStorage.setItem(STORAGE_KEY, '1');
    }
  }, []);

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={() => setVisible(v => !v)}
        className="w-7 h-7 flex items-center justify-center rounded-full border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] text-xs font-bold text-[var(--color-text-muted)] transition-colors"
        title="Voice command help"
        aria-label="Toggle voice command help"
      >
        ?
      </button>

      {/* Help overlay */}
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full right-0 mb-2 w-72 p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg z-50"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">What can I say?</h3>
              <button
                onClick={() => setVisible(false)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-sm leading-none"
                aria-label="Dismiss"
              >
                &times;
              </button>
            </div>
            <div className="space-y-3">
              {HELP_GROUPS.map(group => (
                <div key={group.label}>
                  <div className="text-xs font-medium text-[var(--color-text-muted)] mb-1">{group.label}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.commands.map(cmd => (
                      <span
                        key={cmd}
                        className="text-xs px-2 py-0.5 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)]"
                      >
                        {cmd}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

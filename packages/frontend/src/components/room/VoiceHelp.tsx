import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const HELP_GROUPS = [
  // Keyboard first: hold-space PTT is the PRIMARY input (mic starts
  // off), and none of these were documented anywhere in the UI.
  { label: 'Keyboard',   commands: ['hold space — talk', 'tap space — pause/resume', '← / → — back / skip', 'S — skip', 'D — go deeper', 'Esc — up a level'] },
  { label: 'Navigation', commands: ['"next"', '"skip"', '"go back"', '"dive deeper"'] },
  { label: 'Control',    commands: ['"pause"', '"resume"', '"mute"', '"exit"'] },
  { label: 'Questions',  commands: ['Just ask anything naturally'] },
  { label: 'Export',     commands: ['"export slides"', '"export markdown"'] },
];

export function VoiceHelp() {
  // No auto-open: the always-visible "?" button IS the discovery
  // affordance. Auto-popping the panel over the diagram on first
  // load was a real first-run Blocker (it obscured primary content)
  // and made scene screenshots non-deterministic.
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        className="flex items-center justify-center rounded-full transition-colors"
        style={{
          width: 28, height: 28,
          border: '1px solid oklch(1 0 0 / 0.1)',
          background: visible ? 'color-mix(in oklch, var(--amber-500) 12%, transparent)' : 'oklch(1 0 0 / 0.03)',
          color: visible ? 'var(--amber-400)' : 'var(--cream-500)',
          fontFamily: 'var(--mono)',
          fontSize: 12,
        }}
        title="Voice command help"
        aria-label="Toggle voice command help"
        aria-expanded={visible}
      >
        ?
      </button>

      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-full right-0 mb-3 z-50"
            style={{
              width: 300,
              padding: 18,
              borderRadius: 'var(--r-lg)',
              background: 'var(--ink-100)',
              border: '1px solid oklch(1 0 0 / 0.08)',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="kicker" style={{ color: 'var(--cream-500)' }}>What can I say?</h3>
              <button
                type="button"
                onClick={() => setVisible(false)}
                className="text-sm leading-none"
                style={{ color: 'var(--cream-500)' }}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
            <div className="space-y-3">
              {HELP_GROUPS.map(group => (
                <div key={group.label}>
                  <div className="kicker mb-1.5" style={{ fontSize: 9.5 }}>{group.label}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {group.commands.map(cmd => (
                      <span
                        key={cmd}
                        className="font-mono"
                        style={{
                          fontSize: 11,
                          padding: '3px 8px',
                          borderRadius: 'var(--r-pill)',
                          background: 'oklch(1 0 0 / 0.04)',
                          border: '1px solid oklch(1 0 0 / 0.06)',
                          color: 'var(--cream-800)',
                        }}
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
    </div>
  );
}

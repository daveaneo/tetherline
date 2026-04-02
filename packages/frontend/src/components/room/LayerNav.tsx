import { motion } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';
import { sendEvent } from '../../lib/ws-client.js';

const LAYERS = [
  { level: 1, icon: '\u{1F441}', label: 'Overview' },
  { level: 2, icon: '\u{1F504}', label: 'Concept' },
  { level: 3, icon: '\u{1F3D7}', label: 'Architecture' },
  { level: 4, icon: '\u{1F9E9}', label: 'Component' },
  { level: 5, icon: '\u{1F4C4}', label: 'Code' },
];

export function LayerNav() {
  const visualLayer = useSessionStore(s => s.visualLayer);
  const phase = useSessionStore(s => s.state.phase);

  // Don't show during analyzing or idle
  if (phase === 'ANALYZING' || phase === 'IDLE' || phase === 'PROPOSAL') return null;

  return (
    <div className="absolute left-3 top-1/2 -translate-y-1/2 z-10 flex flex-col gap-2">
      {LAYERS.map(({ level, icon, label }) => {
        const isCurrent = visualLayer === level;
        const isPast = visualLayer > level;

        return (
          <button
            key={level}
            onClick={() => {
              // Navigate to this layer via zoom commands
              if (level < visualLayer) {
                for (let i = 0; i < visualLayer - level; i++) {
                  sendEvent({ type: 'command:previous' });
                }
              } else if (level > visualLayer) {
                for (let i = 0; i < level - visualLayer; i++) {
                  sendEvent({ type: 'command:dive_deeper' });
                }
              }
            }}
            className={`group flex items-center gap-2 transition-all ${
              isCurrent ? 'opacity-100' : 'opacity-40 hover:opacity-70'
            }`}
            title={label}
          >
            <motion.div
              animate={{
                scale: isCurrent ? 1 : 0.8,
                boxShadow: isCurrent ? '0 0 12px rgba(99, 102, 241, 0.4)' : '0 0 0px transparent',
              }}
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm border transition-colors ${
                isCurrent
                  ? 'bg-[var(--color-accent)]/20 border-[var(--color-accent)]/50'
                  : isPast
                  ? 'bg-[var(--color-surface)] border-[var(--color-border)]'
                  : 'bg-transparent border-[var(--color-border)]/50'
              }`}
            >
              {icon}
            </motion.div>
            <span className={`text-[10px] font-medium hidden group-hover:block ${
              isCurrent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
            }`}>
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

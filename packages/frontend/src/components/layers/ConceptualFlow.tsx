import { motion } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';

/**
 * Layer 2 — Conceptual Flow.
 * An animated vertical stepper/timeline showing how the project works
 * at a high conceptual level. Each step fades in with a stagger delay.
 */
export function ConceptualFlow() {
  const conceptualSteps = useSessionStore(s => s.conceptualSteps);

  if (conceptualSteps.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4 opacity-30">🔄</div>
          <p className="text-[var(--color-text-muted)]">Generating conceptual overview...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex items-center justify-center p-8 overflow-y-auto">
      <div className="max-w-lg w-full">
        <motion.h2
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-xl font-semibold mb-8 text-center"
        >
          How It Works
        </motion.h2>

        <div className="space-y-1">
          {conceptualSteps.map((step, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.4, duration: 0.4, ease: 'easeOut' }}
              className="flex items-start gap-4"
            >
              {/* Step icon + connector line */}
              <div className="flex flex-col items-center flex-shrink-0">
                <div className="w-10 h-10 rounded-full bg-[var(--color-accent)]/20 border border-[var(--color-accent)]/40 flex items-center justify-center text-lg">
                  {step.icon}
                </div>
                {i < conceptualSteps.length - 1 && (
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: 24 }}
                    transition={{ delay: i * 0.4 + 0.3, duration: 0.3 }}
                    className="w-0.5 bg-[var(--color-border)] mt-2"
                  />
                )}
              </div>

              {/* Content */}
              <div className="pt-1.5 pb-4">
                <h3 className="font-medium text-sm">{step.title}</h3>
                <p className="text-sm text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                  {step.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

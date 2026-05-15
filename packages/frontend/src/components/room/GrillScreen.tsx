/** The grill quiz screen — a calm, in-theme animated `?` glyph that
 *  replaces the diagram while a grill is active. Ember/espresso skin
 *  only (oklch ink/cream/amber tokens, the same soft pulse/blur used
 *  elsewhere). No new visual vocabulary. The question text itself
 *  lives in HermesText, not here — this is purely the mode surface. */
import { motion } from 'framer-motion';
import { prefersReducedMotion } from './transition-motion.js';

export function GrillScreen({ topic }: { topic?: string }) {
  const reduced = prefersReducedMotion();
  return (
    <div
      data-testid="grill-screen"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 22,
        background:
          'radial-gradient(circle at 50% 45%, oklch(0.22 0.02 65 / 0.6), oklch(0.14 0.01 60 / 0.92))',
        backdropFilter: 'blur(6px)',
        pointerEvents: 'none',
      }}
    >
      <motion.svg
        width={148}
        height={148}
        viewBox="0 0 100 100"
        initial={reduced ? false : { opacity: 0, scale: 0.9 }}
        animate={
          reduced
            ? { opacity: 1 }
            : { opacity: [0.78, 1, 0.78], scale: [1, 1.045, 1] }
        }
        transition={reduced ? { duration: 0 } : { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
        aria-hidden
      >
        <circle cx="50" cy="50" r="46" fill="none" stroke="oklch(0.74 0.12 65 / 0.35)" strokeWidth="1.5" />
        <text
          x="50"
          y="50"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="54"
          fontFamily="var(--serif, Georgia, serif)"
          fill="oklch(0.80 0.13 70)"
        >
          ?
        </text>
      </motion.svg>
      <div
        className="font-mono"
        style={{
          fontSize: 12,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--cream-500, oklch(0.7 0.03 75))',
        }}
      >
        {topic ? `Grilling · ${topic}` : 'Grilling'}
      </div>
    </div>
  );
}

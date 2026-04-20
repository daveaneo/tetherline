import { motion } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';

/** Slim breadcrumb of the Navigator stack. Always-visible in-session so the
 *  user knows where they are and can see how deep they've gone. */
export function BreadcrumbStrip() {
  const { depth, frames } = useSessionStore(s => s.breadcrumb);
  if (depth === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="flex items-center gap-2"
      style={{
        padding: '8px 18px',
        background: 'color-mix(in oklch, var(--ink-100) 60%, transparent)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid oklch(1 0 0 / 0.04)',
        fontSize: 12,
        fontFamily: 'var(--mono)',
        letterSpacing: '0.04em',
        color: 'var(--cream-500)',
      }}
    >
      <span className="kicker" style={{ fontSize: 9.5 }}>Where</span>
      {frames.map((f, i) => (
        <span key={f.briefingId + i} className="flex items-center gap-2">
          {i > 0 && <span style={{ opacity: 0.4 }}>›</span>}
          <span
            style={{
              color: i === frames.length - 1 ? 'var(--amber-400)' : 'var(--cream-600)',
              fontFamily: 'var(--serif)',
              fontStyle: i === frames.length - 1 ? 'italic' : 'normal',
              fontSize: 13,
              letterSpacing: '-0.005em',
            }}
          >
            {f.title}
          </span>
        </span>
      ))}
      {depth >= 4 && (
        <span style={{ marginLeft: 'auto', color: 'var(--cream-500)', fontSize: 10.5 }}>
          Say &ldquo;back to the overview&rdquo; anytime
        </span>
      )}
    </motion.div>
  );
}

import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';
import { LEVEL_LABEL } from '@tetherline/shared';
import { levelColor } from '../room/level-color.js';

/** Toggleable overlay showing the user's comprehension levels across the
 *  briefings they've touched this session. Activates on utterance or from the
 *  Room chrome toggle. */
export function ComprehensionOverlay() {
  const show = useSessionStore(s => s.showComprehensionOverlay);
  // Select the Map reference itself — Zustand compares by reference, so this
  // only re-fires when the Map is replaced (done immutably on updates).
  const comprehensionMap = useSessionStore(s => s.comprehensionMap);
  const toggle = useSessionStore(s => s.toggleComprehensionOverlay);
  // Derive the array inside the component so the selector returns a stable
  // reference. Otherwise `Array.from(...entries())` returned a fresh array
  // every render → React loop → "Maximum update depth exceeded".
  const mapEntries = useMemo(() => Array.from(comprehensionMap.entries()), [comprehensionMap]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="fixed bottom-28 right-6 z-40"
          style={{
            width: 320,
            maxHeight: '60vh',
            overflow: 'auto',
            background: 'color-mix(in oklch, var(--ink-100) 95%, transparent)',
            backdropFilter: 'blur(16px)',
            border: '1px solid oklch(1 0 0 / 0.06)',
            borderRadius: 'var(--r-lg)',
            boxShadow: 'var(--shadow-2)',
            padding: 20,
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="kicker">Your map</div>
              <h3 className="font-serif" style={{ fontSize: 18, fontWeight: 300, letterSpacing: '-0.01em', color: 'var(--cream-900)' }}>
                Comprehension
              </h3>
            </div>
            <button
              type="button"
              onClick={toggle}
              style={{ color: 'var(--cream-500)', fontSize: 18 }}
              aria-label="Close overlay"
            >
              ×
            </button>
          </div>

          {mapEntries.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--cream-500)', lineHeight: 1.5 }}>
              Nothing tracked yet. As the AI walks you through the codebase, this map fills in.
            </p>
          ) : (
            <div className="space-y-2">
              {mapEntries.map(([id, item]) => (
                <div key={id} className="flex items-center gap-3">
                  <span
                    style={{
                      width: 10, height: 10, borderRadius: 2,
                      background: levelColor(item.level) ?? 'var(--heat-0)',
                      flex: 'none',
                      boxShadow: item.level === 'confirmed' ? '0 0 6px var(--amber-500)' : 'none',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="font-serif"
                      style={{
                        fontSize: 14, letterSpacing: '-0.005em', color: 'var(--cream-900)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {item.label}
                    </div>
                    <div className="font-mono" style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
                      {item.layer} · {LEVEL_LABEL[item.level]}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Small pill button that toggles the overlay. Placed in the Room chrome. */
export function ComprehensionToggle() {
  const count = useSessionStore(s => s.comprehensionMap.size);
  const show = useSessionStore(s => s.showComprehensionOverlay);
  const toggle = useSessionStore(s => s.toggleComprehensionOverlay);

  return (
    <button
      type="button"
      onClick={toggle}
      className="chrome-tab"
      aria-pressed={show}
      title="Toggle comprehension overlay"
    >
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, opacity: 0.8 }}>▦</span>
      <span>Map</span>
      {count > 0 && (
        <span
          className="font-mono"
          style={{
            fontSize: 10,
            padding: '0 6px',
            background: 'oklch(1 0 0 / 0.06)',
            borderRadius: 'var(--r-pill)',
            color: 'var(--amber-400)',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

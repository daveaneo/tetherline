/** Transition-grammar motion (B2).
 *
 * The dispatcher (B0) classifies the navigational relationship; this
 * module maps that relationship to the MOTION the diagram plays, so
 * the animation itself tells the user what kind of move happened.
 *
 * Two invariants the plan requires and the tests enforce strictly:
 *  - DESCEND and ASCEND are ONE animation played forward/backward —
 *    `inverse(DESCEND) === ASCEND` exactly, and `inverse` is an
 *    involution. This is what lets the time-slider rewind a DESCEND
 *    as an ASCEND and land on the identical prior layout.
 *  - LATERAL claims NO spatial continuity (scale stays 1 — a cut /
 *    crossfade, never a fake zoom).
 *
 * `prefers-reduced-motion` degrades every transition to an instant
 * change while PRESERVING the transition kind, so an accompanying
 * caption ("↓ core" / "↑ project") still reads. We never strip the
 * relationship, only the motion.
 */
import type { VisualTransition } from '@tetherline/shared';

export interface MotionSpec {
  /** framer-motion `initial` (pre-enter) state. */
  initial: { opacity: number; scale: number; x: number };
  /** framer-motion `animate` (settled) state. */
  animate: { opacity: number; scale: number; x: number };
  /** seconds; 0 under reduced motion. */
  duration: number;
  /** stagger between child reveals (GENERATE draws itself in). */
  staggerChildren: number;
  /** the relationship, preserved even when motion is stripped. */
  kind: VisualTransition;
}

const SETTLED = { opacity: 1, scale: 1, x: 0 };

/** The inverse relationship — what scrubbing BACK through this
 *  transition on the time-slider plays. An involution. */
export function inverseTransition(t: VisualTransition): VisualTransition {
  switch (t) {
    case 'DESCEND':
      return 'ASCEND';
    case 'ASCEND':
      return 'DESCEND';
    // LATERAL/IN_PLACE/GENERATE are their own inverses (no spatial
    // forward/backward pair to flip).
    default:
      return t;
  }
}

export function motionVariantFor(
  transition: VisualTransition,
  reducedMotion: boolean,
): MotionSpec {
  const base = (initial: MotionSpec['initial'], duration: number, stagger = 0): MotionSpec => ({
    initial: reducedMotion ? { ...SETTLED } : initial,
    animate: { ...SETTLED },
    duration: reducedMotion ? 0 : duration,
    staggerChildren: reducedMotion ? 0 : stagger,
    kind: transition,
  });

  switch (transition) {
    case 'IN_PLACE':
      // No motion ever — the overlay/pulse is the response.
      return base({ ...SETTLED }, 0);
    case 'DESCEND':
      // Child expands to fill: grows from small + fades in.
      return base({ opacity: 0, scale: 0.62, x: 0 }, 0.42);
    case 'ASCEND':
      // Exact inverse of DESCEND: arrives from LARGE, shrinking back
      // into the parent. (Same animation, opposite scale direction.)
      return base({ opacity: 0, scale: 1.62, x: 0 }, 0.42);
    case 'LATERAL':
      // A cut: crossfade + small slide. NO scale continuity — we do
      // not fake a spatial relationship that doesn't exist.
      return base({ opacity: 0, scale: 1, x: 24 }, 0.3);
    case 'GENERATE':
      // The scaffold assembles itself: container fades, children
      // stagger-in (drawn while narrated).
      return base({ opacity: 0, scale: 0.96, x: 0 }, 0.5, 0.08);
  }
}

/** Derive the transition kind purely from the scope path change.
 *  Scope ids are path-like ("project", "module/core",
 *  "file/core/loader.py"); "project" is the root ancestor of all.
 *  - same scope            → IN_PLACE
 *  - next is ancestor      → ASCEND
 *  - next is descendant    → DESCEND
 *  - otherwise (unrelated) → LATERAL (a cut, no faked continuity) */
export function scopeTransition(prev: string | null, next: string): VisualTransition {
  if (prev === null || prev === next) return prev === next ? 'IN_PLACE' : 'DESCEND';
  if (next === 'project' && prev !== 'project') return 'ASCEND';
  if (prev === 'project' && next !== 'project') return 'DESCEND';
  const isAncestor = (a: string, b: string) => b.startsWith(a + '/');
  if (isAncestor(next, prev)) return 'ASCEND';
  if (isAncestor(prev, next)) return 'DESCEND';
  return 'LATERAL';
}

/** True if the OS asked for reduced motion. Guarded for non-browser
 *  (tests / SSR) — defaults to false. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

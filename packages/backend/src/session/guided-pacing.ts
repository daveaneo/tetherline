/** Guided-learning inter-beat pacing (B15).
 *
 * The missing piece vs. today's walkthrough: a ~5s breathing pause
 * between beats so guided-learning feels lean-back/movie, not a
 * fire-hose. Pure + deterministic.
 *
 *  - lean-back (watching): full pause between beats.
 *  - the user barged in (a deviation is active): NO pause — they're
 *    leaning in, responsiveness wins (the no-interrupt / prompt-reply
 *    north star). Pacing only applies to the autonomous spine walk.
 *  - reduced-motion / accessibility: shorter, not zero (still paced
 *    so it doesn't fire-hose, but snappier).
 */
export const DEFAULT_INTER_BEAT_MS = 5000;

export interface PacingCtx {
  /** A barge-in deviation is active → user is leaning in. */
  inDeviation: boolean;
  /** OS prefers reduced motion. */
  reducedMotion?: boolean;
  /** Optional override (tests / settings). */
  overrideMs?: number;
}

export function interBeatDelayMs(ctx: PacingCtx): number {
  if (typeof ctx.overrideMs === 'number') return Math.max(0, ctx.overrideMs);
  // Leaning in beats leaning back: a barged-in user must not wait.
  if (ctx.inDeviation) return 0;
  if (ctx.reducedMotion) return 1500;
  return DEFAULT_INTER_BEAT_MS;
}

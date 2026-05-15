/** Compare v1 — narrated sequential tour (B7).
 *
 * One `compare` skill, an `axis` param (decided in the plan):
 *  - structural   ("core vs colab")        → tour: show A, then B,
 *                                             synthesize the contrast.
 *  - temporal     ("how did X change")     → single subject, diff
 *                                             narrated IN_PLACE (the
 *                                             overlay-diff visual is
 *                                             v3; v1 is verbal).
 *  - vs-external  ("vs Django")            → no second code entity;
 *                                             route like explain.
 *
 * v1 uses ONLY existing transitions (B2): show A via DESCEND, a
 * LATERAL cut to B (no faked continuity — they're unrelated), then
 * the synthesis spoken back at the parent. Pure + deterministic so
 * the tour and the axis are unit-testable without the LLM.
 */

export type CompareAxis = 'structural' | 'temporal' | 'vs-external';

export interface TourStep {
  /** Logical scope/subject this step focuses. */
  subject: string;
  /** Transition used to ARRIVE at this step (B2 grammar). */
  transition: 'DESCEND' | 'LATERAL' | 'IN_PLACE' | 'ASCEND';
  /** What Hermes does on this step. */
  beat: 'show' | 'contrast' | 'synthesis';
}

const EXTERNAL_HINTS =
  /\b(django|rails|react|vue|spring|express|flask|fastapi|laravel|nextjs|other (project|codebase|framework|libraries?))\b/i;
const TEMPORAL_HINTS =
  /\b(change[d]?|since|before and after|last week|over time|history|evolv|used to|previously)\b/i;

/** Deterministic axis classification. Explicit param wins; else
 *  keyword heuristic; structural is the default (two entities now). */
export function classifyAxis(
  params: Record<string, string>,
  target: string,
): CompareAxis {
  const explicit = (params.axis ?? '').toLowerCase().trim();
  if (explicit === 'structural' || explicit === 'temporal' || explicit === 'vs-external') {
    return explicit;
  }
  const hay = `${target} ${Object.values(params).join(' ')}`;
  if (EXTERNAL_HINTS.test(hay)) return 'vs-external';
  if (TEMPORAL_HINTS.test(hay)) return 'temporal';
  return 'structural';
}

/** The ordered tour for a comparison. Pure; transitions are exactly
 *  the B2 grammar so no new motion is invented. */
export function compareTourPlan(
  a: string,
  b: string | undefined,
  axis: CompareAxis,
): TourStep[] {
  if (axis === 'structural' && b) {
    return [
      { subject: a, transition: 'DESCEND', beat: 'show' },
      // LATERAL: A and B are unrelated branches — a clean cut, never
      // a faked spatial zoom between them.
      { subject: b, transition: 'LATERAL', beat: 'contrast' },
      // Synthesis spoken back at the parent (ASCEND), holding both.
      { subject: `${a} vs ${b}`, transition: 'ASCEND', beat: 'synthesis' },
    ];
  }
  // temporal & vs-external: a single subject, no second visual in v1.
  return [{ subject: a, transition: 'IN_PLACE', beat: 'synthesis' }];
}

/** Comprehension log (B8).
 *
 * When a grill ends it drops a comprehension-log artifact on the
 * review shelf (the shelf itself is B9/B10; this is the pure builder
 * it will store + render). Turns a finished GrillSession into a
 * compact, glanceable record: what was grilled, how it went, the
 * weak spot. Pure + deterministic so it is unit-testable and
 * cacheable.
 */
import type { GrillSession } from './grill.js';

export interface ComprehensionLogEntry {
  kind: 'comprehension';
  topic: string;
  tone: GrillSession['tone'];
  asked: number;
  strong: number;
  partial: number;
  weak: number;
  /** First weak/partial question — the actionable "study this". */
  weakSpot?: string;
  finalNote?: string;
  /** One glanceable line for the shelf row. */
  summary: string;
  createdAt: string;
}

export function buildComprehensionLog(
  session: GrillSession,
  now: () => Date = () => new Date(),
): ComprehensionLogEntry {
  const answered = session.turns.filter(t => t.evaluation);
  const strong = answered.filter(t => t.evaluation === 'strong').length;
  const partial = answered.filter(t => t.evaluation === 'partial').length;
  const weak = answered.filter(t => t.evaluation === 'weak').length;
  const weakTurn =
    session.turns.find(t => t.evaluation === 'weak') ??
    session.turns.find(t => t.evaluation === 'partial');

  // Glanceable verdict word from the answered ratio (not total — an
  // abandoned grill shouldn't read as "weak").
  let verdict = 'untested';
  if (answered.length > 0) {
    const ratio = strong / answered.length;
    verdict = ratio >= 0.75 ? 'solid' : ratio >= 0.4 ? 'shaky' : 'weak';
  }
  const summary =
    `${session.topic}: ${verdict} (${strong}/${answered.length} strong)` +
    (weakTurn ? ` — weak spot: ${shorten(weakTurn.question)}` : '');

  return {
    kind: 'comprehension',
    topic: session.topic,
    tone: session.tone,
    asked: session.turns.length,
    strong,
    partial,
    weak,
    weakSpot: weakTurn?.question,
    finalNote: session.finalNote,
    summary,
    createdAt: now().toISOString(),
  };
}

function shorten(q: string, max = 60): string {
  const s = q.trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

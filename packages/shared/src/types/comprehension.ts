export type ComprehensionLevel =
  | 'unknown'
  | 'mentioned'
  | 'heard'
  | 'engaged'
  | 'explained'
  | 'confirmed';

export const COMPREHENSION_ORDER: ComprehensionLevel[] = [
  'unknown', 'mentioned', 'heard', 'engaged', 'explained', 'confirmed',
];

export type ComprehensionItemLayer =
  | 'project'
  | 'architecture'
  | 'module'
  | 'file'
  | 'code'
  | 'concept';

export interface ComprehensionItem {
  repoPath: string;
  /** Matches the briefing id when applicable (e.g. 'project', 'module/payments'). */
  itemId: string;
  layer: ComprehensionItemLayer;
  label: string;
  level: ComprehensionLevel;
  narrationSecondsHeard: number;
  questionsAsked: number;
  /** Passed a grill quiz (≥60% strong over ≥3 Qs) or a perfect formal
   *  quiz (3/3). A SEPARATE active-recall QA proof — independent of and
   *  monotonic vs `level` (never set by passive observation). */
  grilled?: boolean;
  /** v3: the node's briefing narration actually finished playing
   *  (real dwell — shown-and-played, not merely emitted). Sole input
   *  to the Seen-coverage metric. */
  seen?: boolean;
  /** v2: last regular quiz result (0/0 = never taken). */
  quizCorrect?: number;
  quizTotal?: number;
  /** v2: last grill result, strong answers / answered (0/0 = never). */
  grillStrong?: number;
  grillAsked?: number;
  lastTouchedAt: string; // ISO
  lastSessionId: string | null;
}

/** An actionable "study this" — a weak/partial quiz/grill question.
 *  Resolvable by the user or auto on a later clean grill; retained
 *  after resolve for audit. */
export interface WeakSpot {
  repoPath: string;
  itemId: string;
  question: string;
  source: 'grill' | 'quiz';
  createdAt: string;
  resolvedAt: string | null;
}

export interface ComprehensionMap {
  repoPath: string;
  items: ComprehensionItem[];
  /** Aggregated counts per level for quick overlay summaries. */
  totals: Record<ComprehensionLevel, number>;
}

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
  lastTouchedAt: string; // ISO
  lastSessionId: string | null;
}

export interface ComprehensionMap {
  repoPath: string;
  items: ComprehensionItem[];
  /** Aggregated counts per level for quick overlay summaries. */
  totals: Record<ComprehensionLevel, number>;
}

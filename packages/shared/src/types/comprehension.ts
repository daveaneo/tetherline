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
  lastTouchedAt: string; // ISO
  lastSessionId: string | null;
}

export interface ComprehensionMap {
  repoPath: string;
  items: ComprehensionItem[];
  /** Aggregated counts per level for quick overlay summaries. */
  totals: Record<ComprehensionLevel, number>;
}

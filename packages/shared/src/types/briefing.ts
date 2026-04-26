export type BriefingLayer = 'project' | 'architecture' | 'module' | 'file' | 'concept' | 'code';

export interface Briefing {
  /** Stable id. Format: <layer>/<path-or-name>. Examples:
   *  - project
   *  - arch/root
   *  - module/payments
   *  - file/src/core/capture.ts
   *  - concept/idempotency
   *  - code/src/core/capture.ts:capture       (whole symbol)
   *  - code/src/core/capture.ts:42-58         (line range)
   */
  id: string;
  repoPath: string;
  layer: BriefingLayer;
  title: string;
  /** 10-30s spoken pitch — TTS-safe: no markdown, no bullets, natural transitions. */
  opener: string;
  /** Optional 30-60s deeper version (played when user says "more"). */
  detail?: string;
  /** 3-5 follow-up hooks the AI can expand on. */
  talkingPoints: string[];
  /** Briefing ids that make sense to drill into from here. */
  children: string[];
  /** One level up. null for root briefings (project layer). */
  parent: string | null;
  visualCue?: {
    kind: 'diagram_focus' | 'code_panel' | 'file_list' | 'none';
    ref?: string;
  };
  estimatedSeconds: number;
  /** Hash of the inputs that produced this briefing. Drives invalidation. */
  sourceHash: string;
  cachedAt: string; // ISO
}

export interface BriefingSummary {
  id: string;
  layer: BriefingLayer;
  title: string;
  estimatedSeconds: number;
  parent: string | null;
  childCount: number;
}

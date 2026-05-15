/** Skill names the intent classifier can route to.
 *
 *  'none' is the explicit "no skill matches" escape hatch. When the
 *  classifier picks 'none', the session manager routes the utterance to
 *  the general conversational handler (handleQuestion) which replies
 *  freely with project context. This prevents the classifier from
 *  force-fitting creative or off-menu requests ("write me a poem",
 *  "what would happen if...") into the nearest available skill, which
 *  was producing the wrong output (e.g. poem requests → whats_changed
 *  skill, follow-up "that wasn't a poem" → critique skill firing a
 *  500-word lecture).
 *
 *  'whats_changed' is the on-demand "catch me up" recap (formerly
 *  'summarize'): what moved since last time, not generic summarization.
 *  It is the user-initiated sibling of the auto-delivered briefing.
 *
 *  'teach' was merged into 'explain' (2026-05-15): explain now handles
 *  both concrete code entities and general concepts, self-adapting.
 *  The deep multi-slide treatment is the separate 'deep_dive'. */
export type SkillName = 'visualize' | 'explain' | 'compare' | 'critique' | 'whats_changed' | 'navigate' | 'annotate' | 'create_issue' | 'share_explanation' | 'grill_me' | 'none';

export interface SkillResult {
  skillName: SkillName;
  type: 'diagram' | 'code' | 'diff' | 'comparison' | 'explanation' | 'annotation';
  narration: string;
  visualPayload: Record<string, unknown>;
  diagramChanges?: {
    focusNodeId?: string;
    expandNodeId?: string;
    zoomLevel?: number;
  };
  understandingUpdates?: Array<{
    layer: string;
    itemId: string;
    status: string;
  }>;
}

export interface IntentClassification {
  skillName: SkillName | 'navigation';
  confidence: number;
  params: Record<string, string>;
  navigationCommand?: string;
}

/** Skill names the intent classifier can route to.
 *
 *  'none' is the explicit "no skill matches" escape hatch. When the
 *  classifier picks 'none', the session manager routes the utterance to
 *  the general conversational handler (handleQuestion) which replies
 *  freely with project context. This prevents the classifier from
 *  force-fitting creative or off-menu requests ("write me a poem",
 *  "what would happen if...") into the nearest available skill, which
 *  was producing the wrong output (e.g. poem requests → summarize skill,
 *  follow-up "that wasn't a poem" → critique skill firing a 500-word
 *  lecture). */
export type SkillName = 'visualize' | 'explain' | 'compare' | 'critique' | 'summarize' | 'navigate' | 'teach' | 'annotate' | 'create_issue' | 'share_explanation' | 'none';

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

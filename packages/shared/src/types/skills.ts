export type SkillName = 'visualize' | 'explain' | 'compare' | 'critique' | 'summarize' | 'navigate' | 'teach' | 'annotate' | 'create_issue' | 'share_explanation';

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

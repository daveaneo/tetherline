import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@interactive-reviewer/shared';

export const explainSkill: Skill = {
  name: 'explain',
  description: 'Explain code, architecture, or concepts with narration and visuals',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.file ?? 'the current area';

    const narration = await context.analyzer.answerQuestion(
      `Explain ${target} in detail. Be conversational — this will be spoken aloud.`,
      `Current area: ${context.currentArea?.name ?? 'none'}. File: ${context.currentFile ?? 'none'}. Repo: ${context.repoPath}.`,
    );

    return {
      skillName: 'explain',
      type: 'explanation',
      narration,
      visualPayload: { target },
      diagramChanges: params.nodeId ? { focusNodeId: params.nodeId } : undefined,
    };
  },
};

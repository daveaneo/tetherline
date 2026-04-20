import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';

export const teachSkill: Skill = {
  name: 'teach',
  description: 'Explain a programming concept in context of the codebase',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const concept = params.target ?? params.concept ?? 'this pattern';

    const narration = await context.analyzer.answerQuestion(
      `Teach me about ${concept}. Explain the concept and how it's used in this codebase specifically. Be clear and conversational — this is narrated aloud. Assume the listener is a developer but may not know this specific pattern.`,
      `Current area: ${context.currentArea?.name ?? 'none'}. Repo: ${context.repoPath}. Languages: ${context.fileTree.slice(0, 5).join(', ')}.`,
    );

    return {
      skillName: 'teach',
      type: 'explanation',
      narration,
      visualPayload: { concept },
      understandingUpdates: [{
        layer: 'code',
        itemId: concept.replace(/\s+/g, '-').toLowerCase(),
        status: 'understood',
      }],
    };
  },
};

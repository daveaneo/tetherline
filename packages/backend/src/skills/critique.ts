import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';

export const critiqueSkill: Skill = {
  name: 'critique',
  description: "Give the AI's opinion on code quality, design, or approach",
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? 'the current code';

    const narration = await context.analyzer.answerQuestion(
      `Give your honest assessment of ${target}. What's good, what could be better, and are there any risks? Be constructive and conversational.`,
      `Current area: ${context.currentArea?.name ?? 'none'}. Repo: ${context.repoPath}.`,
    );

    return {
      skillName: 'critique',
      type: 'explanation',
      narration,
      visualPayload: { target },
    };
  },
};

import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@interactive-reviewer/shared';

export const visualizeSkill: Skill = {
  name: 'visualize',
  description: 'Generate a visual diagram of architecture, data flow, or dependencies',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? 'the current component';

    const narration = await context.analyzer.answerQuestion(
      `Describe the visual structure of ${target} for a diagram. What are the key components and how do they connect? Keep it brief — this will be narrated aloud.`,
      `Repo: ${context.repoPath}. Areas: ${context.areas.map(a => a.name).join(', ')}.`,
    );

    return {
      skillName: 'visualize',
      type: 'diagram',
      narration,
      visualPayload: { target },
    };
  },
};

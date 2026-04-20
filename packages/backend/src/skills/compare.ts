import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';

export const compareSkill: Skill = {
  name: 'compare',
  description: 'Show before/after differences for code changes',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.file ?? 'the recent changes';

    const narration = await context.analyzer.answerQuestion(
      `Compare the before and after for ${target}. What changed and why? Be conversational.`,
      `Current area: ${context.currentArea?.name ?? 'none'}. Affected files: ${context.currentArea?.affectedFiles?.slice(0, 10).join(', ') ?? 'none'}.`,
    );

    return {
      skillName: 'compare',
      type: 'diff',
      narration,
      visualPayload: { target, filePath: params.file },
    };
  },
};

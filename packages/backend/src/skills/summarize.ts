import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';

export const summarizeSkill: Skill = {
  name: 'summarize',
  description: 'Provide a condensed overview',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? context.currentArea?.name ?? 'the current area';

    const narration = await context.analyzer.answerQuestion(
      `Give a very brief summary of ${target} in 2-3 sentences. Hit the key points only. This is spoken aloud.`,
      `Areas: ${context.areas.map(a => `${a.name}: ${a.description}`).join('; ')}`,
    );

    return {
      skillName: 'summarize',
      type: 'explanation',
      narration,
      visualPayload: { target },
    };
  },
};

import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction } from './params-helper.js';

export const critiqueSkill: Skill = {
  name: 'critique',
  description: "Give the AI's opinion on code quality, design, or approach",
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.subject ?? 'the current code';

    const prompt = [
      `Give your honest assessment of ${target}.`,
      constraintInstruction(
        params,
        ['target', 'subject'],
        '3-4 sentences max: ONE thing that\'s good, ONE thing that worries you, ONE specific risk. Skip preamble. Be constructive and conversational.',
      ),
      'Spoken aloud — natural prose, no bullets.',
    ].join(' ');

    const narration = await context.analyzer.answerQuestion(
      prompt,
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

import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction } from './params-helper.js';

export const teachSkill: Skill = {
  name: 'teach',
  description: 'Explain a programming concept in context of the codebase',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const concept = params.target ?? params.concept ?? params.topic ?? 'this pattern';

    const prompt = [
      `Teach me about ${concept}. Cover the concept itself AND how it's used in this codebase specifically.`,
      constraintInstruction(
        params,
        ['target', 'concept', 'topic'],
        '4-5 sentences. Start with what the concept IS in one line, then how it shows up here. Conversational. The user can ask "go deeper" if they want more.',
      ),
      'Spoken aloud — natural prose, no markdown. Assume the listener is a developer but may not know this specific pattern.',
    ].join(' ');

    const narration = await context.analyzer.answerQuestion(
      prompt,
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

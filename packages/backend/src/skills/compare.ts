import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction } from './params-helper.js';

export const compareSkill: Skill = {
  name: 'compare',
  description: 'Show before/after differences for code changes',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.file ?? params.module1
      ? `${params.module1}${params.module2 ? ` and ${params.module2}` : ''}`
      : 'the recent changes';
    const finalTarget = typeof target === 'string' ? target : 'the recent changes';

    const prompt = [
      `Compare ${finalTarget}. What's different and why does it matter?`,
      constraintInstruction(
        params,
        ['target', 'file', 'module1', 'module2'],
        '3-4 sentences. State the key contrast first, then the consequence. Conversational.',
      ),
      'Spoken aloud — natural prose, no markdown.',
    ].join(' ');

    const narration = await context.analyzer.answerQuestion(
      prompt,
      `Current area: ${context.currentArea?.name ?? 'none'}. Affected files: ${context.currentArea?.affectedFiles?.slice(0, 10).join(', ') ?? 'none'}.`,
    );

    return {
      skillName: 'compare',
      type: 'diff',
      narration,
      visualPayload: { target: finalTarget, filePath: params.file },
    };
  },
};

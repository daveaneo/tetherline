import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction, formatParamsAsConstraints } from './params-helper.js';

export const whatsChangedSkill: Skill = {
  name: 'whats_changed',
  description: 'Catch you up on what changed recently',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    // The classifier hands us a free-form params dict — keys vary
    // ("word_limit", "length", "constraint", "length_constraint",
    // "format", "lines", "tone", "scope", "target", ...). We pass them
    // through to the answer LLM as natural-language constraints so
    // arbitrary instructions (under 10 words, two lines, etc.) work
    // without us reconstructing a typed value per key.
    const scope = params.scope ?? (params.target ? 'area' : 'auto');
    const target =
      params.target
        ?? (scope === 'project'
              ? 'this project'
              : context.currentArea?.name ?? 'this project');

    const contextSummary = scope === 'project'
      ? (context.contextComposer?.getProjectContext()
          ?? `Areas: ${context.areas.map(a => `${a.name}: ${a.description}`).join('; ')}`)
      : `Areas: ${context.areas.map(a => `${a.name}: ${a.description}`).join('; ')}`;

    const prompt = [
      `Catch me up on ${target} — what changed recently and why it matters.`,
      'Lead with what moved, not a timeless description of what it is.',
      constraintInstruction(params, ['scope', 'target'], '2-3 sentences. The most important changes only.'),
      'This is spoken aloud — natural prose, no markdown, no bullet lists.',
    ].join(' ');

    const narration = await context.analyzer.answerQuestion(prompt, contextSummary, { params, currentFile: context.currentFile });

    return {
      skillName: 'whats_changed',
      type: 'explanation',
      narration,
      visualPayload: {
        target,
        constraints: formatParamsAsConstraints(params, ['scope', 'target']) || undefined,
      },
    };
  },
};

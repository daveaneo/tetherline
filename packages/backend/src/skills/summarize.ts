import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction, formatParamsAsConstraints } from './params-helper.js';

export const summarizeSkill: Skill = {
  name: 'summarize',
  description: 'Provide a condensed overview',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    // The classifier hands us a free-form params dict — keys vary
    // ("word_limit", "length", "constraint", "length_constraint",
    // "format", "lines", "tone", "scope", "target", ...). Previously
    // this skill extractWordLimit'd against a hard-coded key list,
    // which dropped any constraint the LLM happened to name something
    // unexpected — losing the user's actual instruction.
    //
    // New approach: pass the params through to the answer LLM as
    // natural-language constraints. The LLM understands "length:
    // under 10 words" without us reconstructing a typed value, and
    // arbitrary constraints (format=poem, lines=two, rhyme=true) work
    // for free. The skill's voice/character lives in the system prompt
    // upstream; the user's specifics live in the user message.
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
      `Summarize ${target}.`,
      constraintInstruction(params, ['scope', 'target'], '2-3 sentences. Hit the key points only.'),
      'This is spoken aloud — natural prose, no markdown, no bullet lists.',
    ].join(' ');

    const narration = await context.analyzer.answerQuestion(prompt, contextSummary);

    return {
      skillName: 'summarize',
      type: 'explanation',
      narration,
      visualPayload: {
        target,
        constraints: formatParamsAsConstraints(params, ['scope', 'target']) || undefined,
      },
    };
  },
};

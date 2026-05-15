import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction } from './params-helper.js';
import { classifyAxis, compareTourPlan } from './compare-tour.js';

export const compareSkill: Skill = {
  name: 'compare',
  description: 'Compare two things along an axis (structural / temporal / vs-external)',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    // Resolve the comparison target from the classifier's free-form
    // params. Most common shapes: `target` (single string),
    // `file` (a file path), or `module1` + optional `module2` (pair).
    // Fall back to "the recent changes" so the prompt always has a
    // subject even when params are sparse.
    let target: string;
    if (params.target) {
      target = params.target;
    } else if (params.file) {
      target = params.file;
    } else if (params.module1) {
      target = params.module2 ? `${params.module1} and ${params.module2}` : params.module1;
    } else {
      target = 'the recent changes';
    }

    const prompt = [
      `Compare ${target}. What's different and why does it matter?`,
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

    // v1 narrated tour (B7): structural compares walk A → B → synthesis
    // using existing B2 transitions; temporal/vs-external stay IN_PLACE.
    const axis = classifyAxis(params, target);
    const a = params.module1 ?? params.target ?? target;
    const b = params.module2;
    const tour = compareTourPlan(a, b, axis);

    return {
      skillName: 'compare',
      type: 'diff',
      narration,
      visualPayload: { target, filePath: params.file, axis, tour },
    };
  },
};

import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction } from './params-helper.js';

export const explainSkill: Skill = {
  name: 'explain',
  description: 'Explain code, architecture, or concepts with narration and visuals',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.file ?? params.component ?? params.topic ?? 'the current area';

    // Default brevity moved to "2-3 conversational sentences" — explain
    // used to default to "in detail" which produced 400+ word
    // monologues. Voice-first: the user can always say "more detail"
    // or "go deeper". Default tight, expand on request.
    const prompt = [
      `Explain ${target}.`,
      constraintInstruction(
        params,
        ['target', 'file', 'component', 'topic', 'nodeId'],
        '2-3 conversational sentences. Hit what the thing IS and one non-obvious detail. The user can ask "more detail" if they want depth.',
      ),
      'Spoken aloud — natural prose, no markdown.',
    ].join(' ');

    const narration = await context.analyzer.answerQuestion(
      prompt,
      `Current area: ${context.currentArea?.name ?? 'none'}. File: ${context.currentFile ?? 'none'}. Repo: ${context.repoPath}.`,
    );

    return {
      skillName: 'explain',
      type: 'explanation',
      narration,
      visualPayload: { target },
      diagramChanges: params.nodeId ? { focusNodeId: params.nodeId } : undefined,
    };
  },
};

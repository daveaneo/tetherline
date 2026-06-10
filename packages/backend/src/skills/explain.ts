import type { BackendSkillResult, Skill, SkillContext } from './registry.js';
import { constraintInstruction } from './params-helper.js';

export const explainSkill: Skill = {
  name: 'explain',
  // Absorbs the former standalone `teach` skill (2026-05-15 merge):
  // one skill for "what does this code do" AND "teach me about <concept>".
  // The prompt self-adapts concept↔entity; a deep multi-slide treatment
  // is the separate explicit `deep_dive`, not this rung.
  description: 'Explain code, architecture, or a concept (grounded in this repo) with narration and visuals',
  async execute(context: SkillContext, params: Record<string, string>): Promise<BackendSkillResult> {
    const target = params.target ?? params.file ?? params.component ?? params.topic ?? params.concept ?? 'the current area';

    // Default brevity moved to "2-3 conversational sentences" — explain
    // used to default to "in detail" which produced 400+ word
    // monologues. Voice-first: the user can always say "more detail"
    // or "deep dive". Default tight, expand on request.
    const prompt = [
      `Explain ${target}.`,
      // Concept↔entity self-adaptation (the absorbed teach behavior):
      'If the target is a concrete code entity in this repo, say what THIS code does plus one non-obvious detail. ' +
      'If it is a general concept, give a one-line plain definition of the concept FIRST, then ground it in how this repo uses it. ' +
      'Decide which based on whether the target names something that exists in the codebase.',
      constraintInstruction(
        params,
        ['target', 'file', 'component', 'topic', 'concept', 'nodeId'],
        '2-3 conversational sentences. The user can say "more detail" for depth, or "deep dive" for the full guided treatment.',
      ),
      'Spoken aloud — natural prose, no markdown, EXCEPT fenced code blocks: anything the user would ' +
      'copy-paste (commands, code) goes in a ```fence``` — it is lifted to the screen with a copy ' +
      'button, never spoken.',
    ].join(' ');

    const ctx = `Current area: ${context.currentArea?.name ?? 'none'}. File: ${context.currentFile ?? 'none'}. Repo: ${context.repoPath}.`;

    // Explain is the dominant real-world skill — stream its answer so the
    // first sentence speaks ~1-2s after the LLM starts, instead of waiting
    // for the full completion. Falls back to the one-shot path when the
    // client can't stream (lightweight test doubles).
    const stream = context.analyzer.answerQuestionStream(prompt, ctx, { params, currentFile: context.currentFile });
    if (stream) {
      return {
        skillName: 'explain',
        type: 'explanation',
        narration: '',
        narrationStream: stream,
        visualPayload: { target },
        diagramChanges: params.nodeId ? { focusNodeId: params.nodeId } : undefined,
      };
    }

    const narration = await context.analyzer.answerQuestion(prompt, ctx, { params, currentFile: context.currentFile });
    return {
      skillName: 'explain',
      type: 'explanation',
      narration,
      visualPayload: { target },
      diagramChanges: params.nodeId ? { focusNodeId: params.nodeId } : undefined,
    };
  },
};

import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';

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

    const constraintHints = formatParamsAsConstraints(params, ['scope', 'target']);
    const defaultBrevity = '2-3 sentences. Hit the key points only.';

    const contextSummary = scope === 'project'
      ? (context.contextComposer?.getProjectContext()
          ?? `Areas: ${context.areas.map(a => `${a.name}: ${a.description}`).join('; ')}`)
      : `Areas: ${context.areas.map(a => `${a.name}: ${a.description}`).join('; ')}`;

    const prompt = [
      `Summarize ${target}.`,
      constraintHints
        ? `Honor these user constraints exactly: ${constraintHints}. Output ONLY the summary itself — no preamble like "here is" or "let me", no trailing commentary.`
        : defaultBrevity,
      'This is spoken aloud — natural prose, no markdown, no bullet lists.',
    ].join(' ');

    const narration = await context.analyzer.answerQuestion(prompt, contextSummary);

    return {
      skillName: 'summarize',
      type: 'explanation',
      narration,
      visualPayload: { target, constraints: constraintHints || undefined },
    };
  },
};

/** Stringify a params dict as a natural-language constraint list the
 *  LLM can honor verbatim. Filters out keys already used elsewhere in
 *  the prompt (e.g. `scope`, `target` — they're inlined into the lead
 *  sentence and don't need repeating).
 *
 *  Output shape: "key: value, key: value" — readable, no escaping
 *  needed for typical params. Returns '' if nothing meaningful. */
function formatParamsAsConstraints(
  params: Record<string, string>,
  excludeKeys: string[],
): string {
  const exclude = new Set(excludeKeys);
  return Object.entries(params)
    .filter(([k, v]) => !exclude.has(k) && typeof v === 'string' && v.trim().length > 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.trim()}`)
    .join(', ');
}

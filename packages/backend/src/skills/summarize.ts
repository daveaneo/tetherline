import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';

export const summarizeSkill: Skill = {
  name: 'summarize',
  description: 'Provide a condensed overview',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    // The intent classifier extracts `scope` ("project" / "area") and
    // sometimes a `word_limit` (e.g. "summarize in 5 words" → "5").
    // Previously this skill ignored both and always returned 2-3
    // sentences about the current area — so a user asking for a
    // 5-word project summary got a 70-word area summary instead.
    const scope = params.scope ?? (params.target ? 'area' : 'auto');
    const target =
      params.target
        ?? (scope === 'project'
              ? 'this project'
              : context.currentArea?.name ?? 'this project');

    // The intent classifier's `params` shape is LLM-free-form: sometimes
    // it returns `word_limit: "5"`, sometimes `constraint: "five words"`,
    // sometimes `length: "in 5 words"`. Extract a number from any of
    // those rather than insisting on one name.
    const wordLimit = extractWordLimit(params);
    const lengthConstraint = wordLimit > 0 && wordLimit <= 50
      ? `Reply with EXACTLY ${wordLimit} words — no preamble, no "here is", no "let me", no trailing comment. ` +
        `Output ONLY the summary phrase itself, ${wordLimit} words long, ending with a period. ` +
        `If you can't do it in ${wordLimit}, get as close as possible. Examples of valid output: ` +
        `"Stay tethered to your codebase." (5 words) / "AI-narrated code review tool." (5 words).`
      : '2-3 sentences. Hit the key points only.';

    const contextSummary = scope === 'project'
      ? (context.contextComposer?.getProjectContext()
          ?? `Areas: ${context.areas.map(a => `${a.name}: ${a.description}`).join('; ')}`)
      : `Areas: ${context.areas.map(a => `${a.name}: ${a.description}`).join('; ')}`;

    const narration = await context.analyzer.answerQuestion(
      `Summarize ${target}. ${lengthConstraint} This is spoken aloud — natural prose, no markdown, no bullet lists.`,
      contextSummary,
    );

    return {
      skillName: 'summarize',
      type: 'explanation',
      narration,
      visualPayload: { target, wordLimit: wordLimit || undefined },
    };
  },
};

/** Best-effort extraction of a word-count cap from the classifier's
 *  free-form params. Handles "5", "five", "5 words", "in 5 words",
 *  "five words", etc. Returns 0 if no usable signal. */
function extractWordLimit(params: Record<string, string>): number {
  const candidates = [
    params.word_limit, params.wordLimit, params.constraint,
    params.length, params.limit, params.brevity, params.size,
  ].filter(Boolean) as string[];

  for (const raw of candidates) {
    const n = parseWordCount(raw);
    if (n > 0) return n;
  }
  return 0;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20,
};

function parseWordCount(s: string): number {
  const lower = s.trim().toLowerCase();
  const digits = lower.match(/(\d+)/);
  if (digits) return parseInt(digits[1], 10);
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return n;
  }
  return 0;
}

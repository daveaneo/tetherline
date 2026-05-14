/**
 * Shared helper for piping the intent classifier's free-form params
 * dict into a skill's LLM prompt as natural-language constraints.
 *
 * Why this exists: the classifier's `params` shape is LLM-free-form —
 * for the same user constraint ("in 5 words"), it might emit
 * {word_limit:"5"}, {length:"5 words"}, {constraint:"five words"},
 * {length_constraint:"under 5 words"}, etc. Skills used to grep for
 * specific keys and silently dropped any constraint named something
 * unexpected. Now every skill stringifies the whole dict and lets the
 * downstream LLM honor whatever the user said in plain English.
 *
 * Usage:
 *   const hints = formatParamsAsConstraints(params, ['target', 'scope']);
 *   const prompt = `Explain ${target}.
 *     ${hints ? `Honor these user constraints exactly: ${hints}.` : ''}
 *     Spoken aloud — natural prose.`;
 */

/** Stringify a params dict as a natural-language constraint list the
 *  LLM can honor verbatim. Filters out keys already inlined elsewhere
 *  in the prompt (e.g. `target`, `scope`).
 *
 *  Output shape: "key: value, key: value" — readable, no escaping
 *  needed for typical params. Returns '' if nothing meaningful. */
export function formatParamsAsConstraints(
  params: Record<string, string>,
  excludeKeys: readonly string[] = [],
): string {
  const exclude = new Set(excludeKeys);
  return Object.entries(params)
    .filter(([k, v]) => !exclude.has(k) && typeof v === 'string' && v.trim().length > 0)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.trim()}`)
    .join(', ');
}

/** Build the standard "honor user constraints" instruction line that
 *  every knowledge skill appends to its prompt. Returns the stricter
 *  honor-constraints form when the classifier extracted anything
 *  non-trivial; otherwise returns the skill's `defaultBrevity` text
 *  (e.g. "2-3 sentences" for summarize). */
export function constraintInstruction(
  params: Record<string, string>,
  excludeKeys: readonly string[],
  defaultBrevity: string,
): string {
  const hints = formatParamsAsConstraints(params, excludeKeys);
  if (!hints) return defaultBrevity;
  return (
    `Honor these user constraints exactly: ${hints}. ` +
    `Output ONLY the answer itself — no preamble like "here is", "let me", "sure", and no trailing commentary or follow-up question.`
  );
}

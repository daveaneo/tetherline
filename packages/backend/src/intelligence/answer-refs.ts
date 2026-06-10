/**
 * The REFS final-line protocol: answer prompts instruct the model to end
 * with one machine-read line — `REFS: name1, name2` (or `REFS: none`) —
 * naming the modules/files/components it actually discussed. The line is
 * stripped before speech and resolved against the anchor index to drive
 * the visual dispatcher. Degrades gracefully when the model omits it.
 */

export const REFS_INSTRUCTION =
  'End your answer with exactly one final line of the form "REFS: name1, name2" ' +
  'listing the modules, files, or components you actually discussed (max 5), or ' +
  '"REFS: none" if none apply. This line is machine-read and never spoken — do ' +
  'not mention it or explain it.';

export function extractRefs(answer: string): { clean: string; refs: string[] } {
  const m = answer.match(/\n?\s*REFS:\s*([^\n]*)\s*$/i);
  if (!m) return { clean: answer.trim(), refs: [] };
  const clean = answer.slice(0, m.index).trimEnd().trim();
  return { clean, refs: parseRefsLine(m[0]) };
}

/** Parse a captured "REFS: …" line (e.g. the splitter's pendingRefsLine). */
export function parseRefsLine(line: string | null): string[] {
  if (!line) return [];
  const body = line.replace(/^\s*REFS:\s*/i, '').trim();
  if (!body || /^none[.!]?$/i.test(body)) return [];
  return body
    .split(/[,;]+/)
    .map(s => s.trim().replace(/[.!]+$/, ''))
    .filter(s => s.length > 0)
    .slice(0, 5);
}

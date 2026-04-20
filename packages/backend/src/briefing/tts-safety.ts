/**
 * Lints briefing text for TTS suitability. Briefings are read aloud — markdown,
 * bullet points, numbered lists, and code fences all sound wrong. A validator
 * catches these before they ship.
 */

export interface TTSSafetyIssue {
  kind: 'markdown_heading' | 'bullet_list' | 'numbered_list' | 'code_fence'
      | 'inline_backticks' | 'html_tag' | 'url_in_prose' | 'long_paragraph'
      | 'too_long' | 'too_short' | 'empty';
  detail: string;
}

export interface TTSSafetyResult {
  ok: boolean;
  issues: TTSSafetyIssue[];
  /** Rough estimate of spoken duration in seconds (≈ 2.5 words/sec). */
  estimatedSeconds: number;
  wordCount: number;
}

const MIN_WORDS = 10;
const WORDS_PER_SECOND = 2.5;
const MAX_SECONDS = 45;         // hard ceiling — briefings must stay under 45s spoken

export function validateTTSText(text: string, opts: { maxSeconds?: number } = {}): TTSSafetyResult {
  const issues: TTSSafetyIssue[] = [];
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const estimatedSeconds = Math.ceil(wordCount / WORDS_PER_SECOND);
  const maxSeconds = opts.maxSeconds ?? MAX_SECONDS;

  if (!trimmed) {
    issues.push({ kind: 'empty', detail: 'briefing text is empty' });
  }
  if (wordCount < MIN_WORDS) {
    issues.push({ kind: 'too_short', detail: `only ${wordCount} words — briefings should be at least ${MIN_WORDS}` });
  }
  if (estimatedSeconds > maxSeconds) {
    issues.push({ kind: 'too_long', detail: `estimated ${estimatedSeconds}s exceeds ${maxSeconds}s ceiling` });
  }
  if (/^#{1,6}\s/m.test(text)) {
    issues.push({ kind: 'markdown_heading', detail: 'markdown headings will be read out as "pound pound"' });
  }
  if (/^\s*[-*+]\s/m.test(text)) {
    issues.push({ kind: 'bullet_list', detail: 'bullet lists sound like a mechanical readout' });
  }
  if (/^\s*\d+\.\s/m.test(text)) {
    issues.push({ kind: 'numbered_list', detail: 'numbered lists break conversational flow' });
  }
  if (/```/.test(text)) {
    issues.push({ kind: 'code_fence', detail: 'code fences should not appear in spoken text' });
  }
  if (/`[^`]+`/.test(text)) {
    issues.push({ kind: 'inline_backticks', detail: 'backtick spans sound awkward — spell out or rephrase' });
  }
  if (/<\/?[a-z][^>]*>/i.test(text)) {
    issues.push({ kind: 'html_tag', detail: 'HTML tags should not appear in spoken text' });
  }
  if (/\bhttps?:\/\/\S+/.test(text)) {
    issues.push({ kind: 'url_in_prose', detail: 'URLs read aloud letter-by-letter — strip them' });
  }

  // Very long paragraphs without breaks are a TTS cadence problem.
  const longestParagraph = trimmed.split(/\n{2,}/).reduce((max, p) => Math.max(max, p.split(/\s+/).length), 0);
  if (longestParagraph > 150) {
    issues.push({ kind: 'long_paragraph', detail: `a paragraph has ${longestParagraph} words — break it up for breathing room` });
  }

  return { ok: issues.length === 0, issues, estimatedSeconds, wordCount };
}

/** Cheap transform: take LLM-summary text that may have markdown / bullets and
 *  produce reasonably TTS-safe text. Not a full rewrite — just enough to not
 *  sound broken. Real quality comes from the BriefingComposer's LLM pass. */
export function stripMarkdownForSpeech(text: string): string {
  let t = text;
  t = t.replace(/^#{1,6}\s+(.*)$/gm, '$1.');               // headings → sentence
  t = t.replace(/^\s*[-*+]\s+/gm, '');                      // bullet markers
  t = t.replace(/^\s*\d+\.\s+/gm, '');                      // numbered markers
  t = t.replace(/```[\s\S]*?```/g, '');                     // code fences (whole blocks)
  t = t.replace(/`([^`]+)`/g, '$1');                        // inline backticks
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');                  // bold
  t = t.replace(/\*([^*]+)\*/g, '$1');                      // italic
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');            // links → just text
  t = t.replace(/\bhttps?:\/\/\S+/g, '');                   // bare URLs
  t = t.replace(/\n{3,}/g, '\n\n');                         // collapse excessive newlines
  return t.trim();
}

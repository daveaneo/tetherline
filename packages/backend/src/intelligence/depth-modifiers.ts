/**
 * Depth modifier detection — phrases that ask Hermes to compress or
 * expand his answers. The detected tier persists for the session so the
 * Q&A scaffold can keep answers calibrated until the user changes their
 * mind.
 *
 * Why it lives separate from navigator-vocab: this isn't a navigation
 * op (the navigator stack doesn't move); it's a cross-cutting
 * preference that shapes any subsequent answer. Treating it as a
 * standalone signal keeps the routing in handleUtterance clean.
 */

export type DepthTier = 'tldr' | 'normal' | 'deep';

const TLDR_PATTERNS: RegExp[] = [
  /\b(?:tldr|tl;dr)\b/i,
  /\b(?:shorter|too long|too much|too detailed)\b/i,
  /\b(?:keep it short|in short|in brief|briefly)\b/i,
  /\b(?:one (?:line|sentence)|a sentence)\b/i,
  /\b(?:summarize|summarise|sum it up)\b/i,
];

const DEEP_PATTERNS: RegExp[] = [
  /\b(?:more|longer|elaborate|expand|in detail|in depth)\b/i,
  /\b(?:go deeper|dig in|dig deeper|drill in)\b/i,
  /\b(?:walk me through|step by step|line by line)\b/i,
  /\bgive me (?:more|details?|specifics)\b/i,
  /\bwhat (?:exactly|specifically)\b/i,
];

export interface DepthSignal {
  tier: DepthTier;
  /** True if the user asked for a depth change just now (vs the
   *  default). Lets the caller emit a confirmation toast. */
  changed: boolean;
}

export function detectDepth(text: string, currentTier: DepthTier = 'normal'): DepthSignal {
  for (const re of DEEP_PATTERNS) {
    if (re.test(text)) {
      return { tier: 'deep', changed: currentTier !== 'deep' };
    }
  }
  for (const re of TLDR_PATTERNS) {
    if (re.test(text)) {
      return { tier: 'tldr', changed: currentTier !== 'tldr' };
    }
  }
  return { tier: currentTier, changed: false };
}

/** Hard sentence cap per tier — the enforcement backstop behind
 *  depthInstruction's soft prompt guidance. The answer streamer aborts
 *  the LLM stream at this many sentences and appends the steering hook,
 *  so a runaway answer can never become a 90-second monologue. */
export function sentenceCap(tier: DepthTier): number {
  switch (tier) {
    case 'tldr': return 2;
    case 'deep': return 8;
    case 'normal':
    default: return 4;
  }
}

/** Length guidance the QA scaffold injects into the LLM system prompt
 *  for the given tier. Keep these terse — the scaffold is already long. */
export function depthInstruction(tier: DepthTier): string {
  switch (tier) {
    case 'tldr':
      return 'The user asked for short answers. Reply in one sentence — no preamble, no follow-up question.';
    case 'deep':
      return 'The user asked for depth. Reply with 5–8 sentences. Cite specific files or symbols when relevant. Concrete > abstract.';
    case 'normal':
    default:
      return 'Reply in 2–4 conversational sentences.';
  }
}

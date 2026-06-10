/**
 * Routing predicates for the grounded-Q&A escalation flow.
 *
 * Normal questions answer from deterministic retrieval (fast, streamable).
 * Two ways to reach the slow-but-thorough AGENTIC path (Claude Code CLI
 * reading the repo itself):
 *   1. an explicit phrase ("deep dive into X", "dig through the code");
 *   2. accepting the offer made after an anchors-only answer
 *      ("Want me to dig through the code to be sure?").
 *
 * Checked AFTER the deterministic fast paths in handleUtterance, so the
 * exact quick-command "dive deeper" keeps its existing navigation meaning.
 */

const ESCALATE_RE =
  /\b(deep[\s-]?dive|dig (?:into|through|in)\b|trace through|go through the (?:actual )?code|actually (?:read|look at) the code|investigate)\b/i;

export function shouldEscalateToAgentic(text: string): boolean {
  return ESCALATE_RE.test(text);
}

const AFFIRMATIVE_RE = /^(?:yes|yeah|yep|sure|ok(?:ay)?|do it|go ahead|please do|dig in)[.! ]*$/i;

/** Matches a short affirmative reply to the pending-escalation offer. */
export function isEscalationAffirmative(text: string): boolean {
  return AFFIRMATIVE_RE.test(text.trim());
}

export const AGENTIC_BUFFER_LINE = 'Let me actually dig through the code — one moment.';
export const ESCALATION_OFFER = 'Want me to dig through the code to be sure?';
export const PENDING_ESCALATION_TTL_MS = 60_000;

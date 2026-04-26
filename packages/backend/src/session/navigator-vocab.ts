/**
 * Voice vocabulary for the Navigator. Maps natural phrasings to stack
 * operations. Covers ~90% of utterances without an LLM round-trip; the intent
 * classifier handles the long tail.
 *
 * Design rules:
 *   - Phrases are checked in priority order (most specific first).
 *   - Each returns an operation name; the caller wires that to Navigator.
 *   - Pure function — no DB access, no state. Easy to unit-test with a table.
 */

export type NavOp =
  | { kind: 'pop' }
  | { kind: 'pop_to_project' }
  | { kind: 'push_named'; target: string }        // e.g. "tell me about payments" → target="payments"
  | { kind: 'push_code'; target: string }         // e.g. "walk me through capture" / "show me the handleQuestion function"
  | { kind: 'dive_deeper' }
  | { kind: 'breadcrumb' }
  | { kind: 'resume' }
  | { kind: 'none' };

interface Rule {
  pattern: RegExp;
  produce: (match: RegExpMatchArray) => NavOp;
}

// Phrases are matched against `text.trim().toLowerCase()`.
// Most specific rules go first.
const RULES: Rule[] = [
  // --- Absolute ---
  { pattern: /\b(back to|go to|take me to) (the )?(overview|project|top|start)\b/, produce: () => ({ kind: 'pop_to_project' }) },
  { pattern: /\b(start over|start again|go home|home)\b/, produce: () => ({ kind: 'pop_to_project' }) },
  { pattern: /\bto the top\b/, produce: () => ({ kind: 'pop_to_project' }) },

  // --- Pop (up one level) ---
  { pattern: /\b(back up|go up|step up|one level up|up a level|go back up)\b/, produce: () => ({ kind: 'pop' }) },
  { pattern: /^(go back|back|take me back)\s*\.?\s*$/, produce: () => ({ kind: 'pop' }) },

  // --- Code-layer drill ("walk me through capture", "show me the handleQuestion function") ---
  // Always check this BEFORE the generic named drill so "walk me through capture"
  // doesn't get routed to module/capture when the user actually wants the code.
  // Note: "explain X function" is intentionally NOT here — it's a more
  // natural fit for the explain skill, which the intent classifier owns.
  { pattern: /^(?:walk me through|step (?:me )?through|trace through|line[ -]by[ -]line(?:\s+through)?) (?:the )?([\w./-]{2,})(?:\s+(?:function|method|class|file|code))?[\s?.!]*$/,
    produce: (m) => ({ kind: 'push_code', target: m[1] }) },
  { pattern: /^(?:show me|let'?s see|open) (?:the )?(?:code (?:for|of)\s+)?([\w./-]+)\s+(?:function|method|class)[\s?.!]*$/,
    produce: (m) => ({ kind: 'push_code', target: m[1] }) },

  // --- Named drill-down ---
  // "tell me about payments", "show me ledger", "look at webhooks", "let's look at webhooks", "let's talk about payments"
  { pattern: /^(?:tell me about|show me|look at|let'?s (?:look at|talk about)) (?:the )?([\w-]{2,})(?:\s+(?:module|work|do|doing|does))?[\s?.!]*$/,
    produce: (m) => ({ kind: 'push_named', target: m[1] }) },
  // "what is the payments module", "what's payments"
  { pattern: /^what(?:'s| is) (?:the )?([\w-]{2,})(?:\s+(?:module|work|do|doing|does|about))?[\s?.!]*$/,
    produce: (m) => ({ kind: 'push_named', target: m[1] }) },
  // "how does payments work", "what does payments do"
  { pattern: /^(?:how does|what does) (?:the )?([\w-]{2,})(?:\s+(?:module|work|do|doing|does))?[\s?.!]*$/,
    produce: (m) => ({ kind: 'push_named', target: m[1] }) },

  // --- Dive deeper (generic) ---
  { pattern: /\b(dive deeper|go deeper|deeper|more detail|tell me more|more)\b/, produce: () => ({ kind: 'dive_deeper' }) },

  // --- Breadcrumb ("where are we") ---
  { pattern: /\b(where (are we|am i)|what are we (doing|looking at)|where (do we stand|did we leave off))\b/,
    produce: () => ({ kind: 'breadcrumb' }) },

  // --- Resume ---
  { pattern: /^(continue|keep going|resume|go on)\s*\.?\s*$/, produce: () => ({ kind: 'resume' }) },
];

/** Resolve a user utterance to a Navigator operation. `none` if no rule matches. */
export function resolveNavOp(text: string): NavOp {
  const t = text.trim().toLowerCase();
  for (const rule of RULES) {
    const m = t.match(rule.pattern);
    if (m) return rule.produce(m);
  }
  return { kind: 'none' };
}

/** The canonical phrase list — used by tests to validate coverage. */
export const CANONICAL_NAV_PHRASES: Array<{ phrase: string; expected: NavOp['kind']; target?: string }> = [
  // POP_TO_PROJECT
  { phrase: 'back to the overview', expected: 'pop_to_project' },
  { phrase: 'back to overview', expected: 'pop_to_project' },
  { phrase: 'take me to the top', expected: 'pop_to_project' },
  { phrase: 'start over', expected: 'pop_to_project' },
  { phrase: 'start again', expected: 'pop_to_project' },
  { phrase: 'go home', expected: 'pop_to_project' },
  { phrase: 'to the top', expected: 'pop_to_project' },

  // POP
  { phrase: 'go back', expected: 'pop' },
  { phrase: 'back', expected: 'pop' },
  { phrase: 'take me back', expected: 'pop' },
  { phrase: 'back up', expected: 'pop' },
  { phrase: 'go up', expected: 'pop' },
  { phrase: 'step up', expected: 'pop' },
  { phrase: 'one level up', expected: 'pop' },
  { phrase: 'up a level', expected: 'pop' },

  // PUSH_NAMED
  { phrase: 'tell me about payments', expected: 'push_named', target: 'payments' },
  { phrase: 'show me ledger', expected: 'push_named', target: 'ledger' },
  { phrase: 'what is the payments module', expected: 'push_named', target: 'payments' },
  { phrase: 'how does ledger work', expected: 'push_named', target: 'ledger' },
  { phrase: "let's look at webhooks", expected: 'push_named', target: 'webhooks' },

  // DIVE_DEEPER
  { phrase: 'dive deeper', expected: 'dive_deeper' },
  { phrase: 'go deeper', expected: 'dive_deeper' },
  { phrase: 'tell me more', expected: 'dive_deeper' },
  { phrase: 'more detail', expected: 'dive_deeper' },

  // BREADCRUMB
  { phrase: 'where are we', expected: 'breadcrumb' },
  { phrase: 'where am i', expected: 'breadcrumb' },
  { phrase: 'what are we doing', expected: 'breadcrumb' },

  // RESUME
  { phrase: 'continue', expected: 'resume' },
  { phrase: 'keep going', expected: 'resume' },
  { phrase: 'resume', expected: 'resume' },
];

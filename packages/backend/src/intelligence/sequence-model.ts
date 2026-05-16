/** Call-path sequence diagrams (B20, Phase C — stretch).
 *
 * "call path of `fn`" → a sequence diagram: ordered participants
 * (lifelines) + ordered messages (calls/returns) down the path.
 *
 * This is the pure, deterministic transform: a resolved call chain →
 * the sequence model the renderer draws. The ts-morph AST crawl that
 * PRODUCES the chain is the integration layer (ts-morph is not a dep
 * yet) — kept separate so the model is testable without it.
 */

export interface CallStep {
  /** Caller symbol (function/method id). */
  from: string;
  /** Callee symbol. */
  to: string;
  /** Optional call label (method name / args summary). */
  label?: string;
}

export interface SequenceModel {
  /** Lifelines in FIRST-APPEARANCE order down the path. */
  participants: string[];
  /** Ordered messages; each carries a depth (call nesting) so the
   *  renderer can show the return arrows. */
  messages: { from: string; to: string; label?: string; depth: number }[];
}

/** Pure. Participants are de-duplicated in first-appearance order
 *  (NOT sorted — sequence order is the meaning). Depth increases on
 *  each forward call and is carried for return rendering. Self-calls
 *  are kept (recursion is real) but flagged via from===to. */
export function buildSequenceModel(chain: CallStep[]): SequenceModel {
  const participants: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      participants.push(id);
    }
  };

  const messages: SequenceModel['messages'] = [];
  let depth = 0;
  for (const step of chain) {
    add(step.from);
    add(step.to);
    messages.push({ from: step.from, to: step.to, label: step.label, depth });
    // A call into a NEW callee deepens the stack; a call back to an
    // already-seen earlier participant is a return (depth−1, floor 0).
    depth = step.from === step.to ? depth : depth + 1;
  }
  return { participants, messages };
}

/** Guard: call paths can explode. Cap the chain so a pathological
 *  recursion / fan-out can't produce an unreadable hairball (same
 *  spirit as the ELK / split-canvas size guards). */
export function clampChain(chain: CallStep[], max = 40): CallStep[] {
  return chain.length <= max ? chain : chain.slice(0, max);
}

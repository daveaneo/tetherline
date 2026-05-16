/** `task` permission ceiling + shelf mapping (B19) — RISKIEST.
 *
 * `task` fires an AI agent that CAN mutate code. The plan's hard
 * safety contract, enforced here as a pure, exhaustively-tested gate:
 *
 *  - The setting is a CEILING. Default `read_only`.
 *  - A task requesting a capability ABOVE the ceiling is REJECTED —
 *    never silently downgraded, never proceeds. The rejection lands
 *    on the shelf (an audit row), it does NOT interrupt the
 *    conversation.
 *  - read_only touches nothing. draft computes a diff but applies
 *    nothing. write applies ONLY on a dedicated branch/worktree
 *    (never the working tree) and still drops a confirm on the shelf
 *    unless full-auto.
 *  - Success AND failure both land on the shelf; the voice loop is
 *    NEVER preempted, at any tier.
 *
 * The in-process agent runner + the actual branch sandboxing are the
 * integration layer. THIS authorization gate is the safety-critical
 * core and is tested for every ceiling×request combination.
 */
import type { ShelfArtifact } from '@tetherline/shared';

export type Capability = 'read_only' | 'draft' | 'write';

// Strictly ordered: a request is allowed iff its rank ≤ the ceiling.
const RANK: Record<Capability, number> = { read_only: 0, draft: 1, write: 2 };

export const DEFAULT_CEILING: Capability = 'read_only';

export type AuthzResult =
  | { allowed: true; capability: Capability }
  | { allowed: false; requested: Capability; ceiling: Capability; reason: string };

/** The gate. Enforces (does not downgrade). */
export function authorizeTask(requested: Capability, ceiling: Capability): AuthzResult {
  if (RANK[requested] <= RANK[ceiling]) {
    return { allowed: true, capability: requested };
  }
  return {
    allowed: false,
    requested,
    ceiling,
    reason: `Task requested "${requested}" but the permission ceiling is "${ceiling}". Raise the ceiling in Settings to allow this.`,
  };
}

/** A rejected task becomes an audit row on the shelf — never a
 *  spoken interruption. */
export function rejectionToShelfArtifact(
  res: Extract<AuthzResult, { allowed: false }>,
  id: string,
  now: () => Date = () => new Date(),
): ShelfArtifact {
  return {
    id,
    section: 'tasks',
    summary: `Blocked: task needed "${res.requested}" (ceiling "${res.ceiling}")`,
    detail: res.reason,
    state: 'blocked',
    createdAt: now().toISOString(),
  };
}

export type TaskOutcome =
  | { kind: 'report'; text: string } // read_only
  | { kind: 'diff'; patch: string; branch: string } // draft/write
  | { kind: 'error'; message: string }; // any failure

/** Task completion (success OR failure) → a shelf row. NEVER returns
 *  anything that interrupts; the shelf is the only channel. */
export function outcomeToShelfArtifact(
  outcome: TaskOutcome,
  title: string,
  id: string,
  now: () => Date = () => new Date(),
): ShelfArtifact {
  const base = { id, section: 'tasks' as const, createdAt: now().toISOString() };
  switch (outcome.kind) {
    case 'report':
      return { ...base, summary: title, detail: outcome.text, state: 'done' };
    case 'diff':
      return {
        ...base,
        summary: `${title} — proposed diff (review & apply)`,
        detail: outcome.patch,
        state: `branch:${outcome.branch}`,
      };
    case 'error':
      // Failure lands here too — it must NOT interrupt the voice loop.
      return { ...base, summary: `${title} — failed`, detail: outcome.message, state: 'error' };
  }
}

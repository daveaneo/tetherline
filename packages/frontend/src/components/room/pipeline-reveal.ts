/** Pipeline walkthrough (B3).
 *
 * "show me the data flow / pipeline" reveals the cached logic-graph
 * one stage at a time, in story order — source → transform → guard →
 * sink — synced to narration. Zero new data: the diagram-extractor
 * already tags each logic node with a `role`.
 *
 * This module is the pure ordering core: given the logic nodes, in
 * what sequence does the diagram light them up. Deterministic so the
 * reveal is identical every run and the narration can be aligned to
 * it. The animation itself reuses B2's motion.
 */

export type PipelineRole = 'source' | 'transform' | 'guard' | 'sink';

const ROLE_ORDER: Record<PipelineRole, number> = {
  source: 0,
  transform: 1,
  guard: 2,
  sink: 3,
};

export interface RevealNode {
  id: string;
  data?: { role?: unknown } & Record<string, unknown>;
}

function roleOf(n: RevealNode): PipelineRole | null {
  const r = n.data?.role;
  return r === 'source' || r === 'transform' || r === 'guard' || r === 'sink' ? r : null;
}

/**
 * The order the diagram reveals stages. Stable: nodes are grouped by
 * pipeline role (source first → sink last); within a role the input
 * order is preserved (the extractor already returns edge order). Nodes
 * with no recognized role are appended last in input order — they are
 * never dropped (a missing role must still appear, just after the
 * story). Pure + deterministic.
 */
export function pipelineRevealOrder<T extends RevealNode>(nodes: T[]): T[] {
  const withRole: { n: T; rank: number; idx: number }[] = [];
  const roleless: T[] = [];
  nodes.forEach((n, idx) => {
    const role = roleOf(n);
    if (role === null) roleless.push(n);
    else withRole.push({ n, rank: ROLE_ORDER[role], idx });
  });
  withRole.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  return [...withRole.map(w => w.n), ...roleless];
}

/** True when this request should drive the pipeline walkthrough
 *  (vs. a normal visualize). Keyword-deterministic, no LLM. */
export function isPipelineRequest(target: string | undefined | null): boolean {
  if (!target) return false;
  const t = target.toLowerCase();
  return /\b(data\s*flow|pipeline|flow|how .* works end to end|walk.*through)\b/.test(t);
}

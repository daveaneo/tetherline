/** Blast-radius ripple (B4).
 *
 * "deps of X" / "what touches X" / "blast radius" → a BFS over the
 * cached import edges, emitted as concentric RINGS by hop distance so
 * the diagram can pulse them outward like a ripple. Pure traversal,
 * zero new data (edges already exist).
 *
 *  - direction 'dependents'  → who imports X (reverse edges): the
 *    blast radius if X changes — the default question.
 *  - direction 'dependencies'→ what X imports (forward edges):
 *    "deps of X".
 *
 * Output is rings[0]=[X], rings[1]=immediate neighbours, … Each ring
 * is sorted for a deterministic, identical-every-run ripple. A node
 * appears in exactly its SHORTEST-distance ring (BFS), never twice.
 */

export interface ImportEdge {
  source: string;
  target: string;
}

export type RippleDirection = 'dependents' | 'dependencies';

export function blastRadiusRings(
  rootId: string,
  edges: ImportEdge[],
  direction: RippleDirection = 'dependents',
  maxHops = 6,
): string[][] {
  // Adjacency in the queried direction. 'dependents' walks edges
  // backwards (target→source): who points AT this node.
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    const [from, to] =
      direction === 'dependents' ? [e.target, e.source] : [e.source, e.target];
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  }

  const seen = new Set<string>([rootId]);
  const rings: string[][] = [[rootId]];
  let frontier = [rootId];

  while (frontier.length > 0 && rings.length <= maxHops) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    if (next.length === 0) break;
    next.sort();
    rings.push(next);
    frontier = next;
  }
  return rings;
}

/** Keyword-deterministic detection — no LLM. */
export function isBlastRadiusRequest(target: string | undefined | null): boolean {
  if (!target) return false;
  return /\b(blast\s*radius|what\s+touches|deps?\s+of|depends?\s+on|impact|ripple)\b/i.test(
    target,
  );
}

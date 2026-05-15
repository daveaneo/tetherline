/** Dependency-cruiser grounding (B12).
 *
 * The plan's pattern: a real import extractor produces a GROUND-TRUTH
 * graph → the LLM only ever SELECTS/labels a subgraph of it → ELK
 * positions → our SVG renders. This stops the LLM hallucinating
 * edges ("deps of X" becomes authoritative).
 *
 * This module is the pure, deterministic boundary:
 *  - `depGraphCacheKey` — keys the crawl on repo HEAD + config, like
 *    every other extractor cache (re-crawl only when code changes).
 *  - `parseDepcruiserModules` — dependency-cruiser's JSON → our
 *    {nodes,edges}.
 *  - `inducedSubgraph` — the LLM picks node ids; we return ONLY the
 *    edges that REALLY exist between them. The model cannot invent an
 *    edge because it never emits edges — it only names nodes.
 *
 * The actual `depcruise` child-process spawn is the integration layer
 * (dependency-cruiser is not yet a dep); these transforms are tested
 * without it.
 */
import { createHash } from 'crypto';

export interface DepNode {
  id: string;
}
export interface DepEdge {
  source: string;
  target: string;
}

/** Stable cache key — re-crawl only when the repo HEAD or the
 *  cruiser config changes. Mirrors the diagram-extractor hashOf. */
export function depGraphCacheKey(repoHead: string, configVersion: string): string {
  return createHash('sha256')
    .update(['depcruise', configVersion, repoHead].join(''))
    .digest('hex')
    .slice(0, 16);
}

/** dependency-cruiser `--output-type json` shape (the subset we use):
 *  { modules: [{ source, dependencies: [{ resolved }] }] }. Pure;
 *  self-edges dropped, edges de-duplicated, deterministic order. */
export function parseDepcruiserModules(
  json: { modules?: { source: string; dependencies?: { resolved: string }[] }[] } | null,
): { nodes: DepNode[]; edges: DepEdge[] } {
  const nodeSet = new Set<string>();
  const edgeSet = new Set<string>();
  const edges: DepEdge[] = [];
  for (const m of json?.modules ?? []) {
    nodeSet.add(m.source);
    for (const d of m.dependencies ?? []) {
      nodeSet.add(d.resolved);
      if (d.resolved === m.source) continue; // no self-edges
      const key = `${m.source}${d.resolved}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ source: m.source, target: d.resolved });
      }
    }
  }
  return {
    nodes: [...nodeSet].sort().map(id => ({ id })),
    edges: edges.sort((a, b) =>
      a.source === b.source ? (a.target < b.target ? -1 : 1) : a.source < b.source ? -1 : 1,
    ),
  };
}

/** The grounding guarantee: given the LLM's chosen node ids, return
 *  only the edges that ACTUALLY exist among them in the ground-truth
 *  graph. The model names nodes; it can never fabricate an edge. */
export function inducedSubgraph(
  groundTruth: { nodes: DepNode[]; edges: DepEdge[] },
  pickedIds: string[],
): { nodes: DepNode[]; edges: DepEdge[] } {
  const pick = new Set(pickedIds);
  const real = new Set(groundTruth.nodes.map(n => n.id));
  const nodes = [...pick].filter(id => real.has(id)).sort().map(id => ({ id }));
  const keep = new Set(nodes.map(n => n.id));
  const edges = groundTruth.edges.filter(e => keep.has(e.source) && keep.has(e.target));
  return { nodes, edges };
}

/** Deterministic layered (left→right) layout for authored pipeline/sequence
 *  diagrams. Pure — no DOM, no framer, no randomness — so the scene harness
 *  gets byte-identical screenshots and the unit tests pin the topology.
 *
 *  Radial layout scattered pipeline stages with long crossing curves (the
 *  "squiggly nonsensical" look, live 2026-06-10). Here, columns = topological
 *  rank (longest-path), source on the left, sink on the right, rows ordered by
 *  predecessor barycenter. Cycles are handled by removing back-edges from the
 *  ranking (they still render, routed under the row by the caller).
 */

export interface LayoutNode {
  id: string;
  /** 'source' | 'transform' | 'guard' | 'sink' — only source/sink nudge layout. */
  role?: string;
}
export interface LayoutEdge {
  from: string;
  to: string;
}
export interface LayeredPosition {
  x: number;
  y: number;
  col: number;
  row: number;
}
export interface LayeredLayout {
  positions: Map<string, LayeredPosition>;
  /** `${from}->${to}` of edges removed to break cycles (render under the row). */
  backEdges: Set<string>;
  columns: number;
}

export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

interface LayeredOpts {
  marginX?: number;
  marginY?: number;
}

export function layeredPositions(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  viewBox: { width: number; height: number },
  opts: LayeredOpts = {},
): LayeredLayout {
  const marginX = opts.marginX ?? 150;
  const marginY = opts.marginY ?? 90;
  const ids = nodes.map(n => n.id);
  const idSet = new Set(ids);
  const inputIndex = new Map(ids.map((id, i) => [id, i]));
  const role = new Map(nodes.map(n => [n.id, n.role]));

  // Clean edges: real endpoints, no self-loops, de-duplicated, input order.
  const seen = new Set<string>();
  const clean: LayoutEdge[] = [];
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to) || e.from === e.to) continue;
    const k = edgeKey(e.from, e.to);
    if (seen.has(k)) continue;
    seen.add(k);
    clean.push({ from: e.from, to: e.to });
  }

  // Adjacency in input/edge order for deterministic DFS.
  const adj = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const e of clean) adj.get(e.from)!.push(e.to);

  // Back-edge detection (DFS): an edge to a node currently on the recursion
  // stack closes a cycle. Those are excluded from ranking.
  const backEdges = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(ids.map(id => [id, 0])); // 0 white,1 gray,2 black
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of adj.get(u)!) {
      const s = state.get(v)!;
      if (s === 1) backEdges.add(edgeKey(u, v));
      else if (s === 0) dfs(v);
    }
    state.set(u, 2);
  };
  for (const id of ids) if (state.get(id) === 0) dfs(id);

  const forward = clean.filter(e => !backEdges.has(edgeKey(e.from, e.to)));

  // Longest-path ranking over the DAG (Kahn topological order).
  const indeg = new Map<string, number>(ids.map(id => [id, 0]));
  const fadj = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const e of forward) {
    fadj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const rank = new Map<string, number>(ids.map(id => [id, 0]));
  const queue = ids.filter(id => indeg.get(id) === 0);
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of fadj.get(u)!) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }

  // Role nudge: a true sink (no forward out-edges) aligns on the right.
  let maxRank = 0;
  for (const id of ids) maxRank = Math.max(maxRank, rank.get(id)!);
  const hasOut = new Map<string, boolean>(ids.map(id => [id, (fadj.get(id)!.length > 0)]));
  for (const id of ids) {
    if (role.get(id) === 'sink' && !hasOut.get(id)) rank.set(id, maxRank);
  }
  maxRank = 0;
  for (const id of ids) maxRank = Math.max(maxRank, rank.get(id)!);
  const columns = maxRank + 1;

  // Column x positions, evenly spread.
  const colX = (c: number) =>
    columns <= 1 ? viewBox.width / 2 : marginX + (c * (viewBox.width - 2 * marginX)) / (columns - 1);

  // Group nodes by column, preserving input order.
  const byCol: string[][] = Array.from({ length: columns }, () => []);
  for (const id of ids) byCol[rank.get(id)!].push(id);

  // Within-column row order: column 0 keeps input order; later columns order
  // by the barycenter of their already-placed forward predecessors.
  const rowOf = new Map<string, number>();
  const positions = new Map<string, LayeredPosition>();
  const preds = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const e of forward) preds.get(e.to)!.push(e.from);

  for (let c = 0; c < columns; c++) {
    const members = byCol[c];
    if (c > 0) {
      members.sort((a, b) => {
        const ba = barycenter(a, preds, rowOf);
        const bb = barycenter(b, preds, rowOf);
        if (ba !== bb) return ba - bb;
        return inputIndex.get(a)! - inputIndex.get(b)!;
      });
    }
    const m = members.length;
    const usableH = viewBox.height - 2 * marginY;
    for (let r = 0; r < m; r++) {
      const id = members[r];
      rowOf.set(id, r);
      const y = m === 1 ? viewBox.height / 2 : marginY + ((r + 0.5) * usableH) / m;
      positions.set(id, { x: colX(c), y, col: c, row: r });
    }
  }

  return { positions, backEdges, columns };
}

function barycenter(id: string, preds: Map<string, string[]>, rowOf: Map<string, number>): number {
  const ps = preds.get(id)!.map(p => rowOf.get(p)).filter((r): r is number => r !== undefined);
  if (ps.length === 0) return Number.POSITIVE_INFINITY; // no placed preds → sink to bottom, stable
  return ps.reduce((s, r) => s + r, 0) / ps.length;
}

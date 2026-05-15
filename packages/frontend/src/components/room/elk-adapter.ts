/** ELK.js layout adapter (B11).
 *
 * ELK is adopted as a LAYOUT ENGINE only (not a renderer): feed it our
 * {nodes,edges}; it returns (x,y) we draw with the existing SVG. The
 * radial layout stays custom (best for the module-overview default);
 * ELK powers the layered/flow/deps layouts the radial math can't do.
 *
 * This module is the pure, deterministic boundary: graph→ELK input,
 * ELK output→positions, and the size guard. The actual async
 * `elk.layout()` call + web worker is the integration layer; keeping
 * the transforms pure makes them unit-testable without running ELK.
 */

export type ElkLayout = 'radial' | 'layered' | 'flow' | 'deps';

export interface GraphNode {
  id: string;
  label?: string;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface ElkInputNode {
  id: string;
  width: number;
  height: number;
}
export interface ElkInputGraph {
  id: 'root';
  layoutOptions: Record<string, string>;
  children: ElkInputNode[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}

const ELK_DIRECTION: Record<Exclude<ElkLayout, 'radial'>, string> = {
  layered: 'DOWN',
  flow: 'RIGHT',
  deps: 'RIGHT',
};

/** Radial stays custom. ELK is used for the other layouts UNLESS the
 *  graph is too big — past the guard we fall back to radial so a
 *  huge repo can't hang layout (the plan's size-guard requirement). */
export function shouldUseElk(
  layout: ElkLayout,
  nodeCount: number,
  maxNodes = 60,
): boolean {
  if (layout === 'radial') return false;
  return nodeCount > 0 && nodeCount <= maxNodes;
}

/** Pure: our graph → ELK input. Deterministic node/edge order
 *  (sorted) so the same graph always lays out identically. */
export function toElkGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  layout: Exclude<ElkLayout, 'radial'>,
  nodeSize = { width: 180, height: 64 },
): ElkInputGraph {
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': ELK_DIRECTION[layout],
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
    },
    children: [...nodes]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(n => ({ id: n.id, width: nodeSize.width, height: nodeSize.height })),
    edges: [...edges]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(e => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
}

export interface ElkLaidNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Pure: ELK output → id→center-point map our SVG consumes. ELK gives
 *  top-left + size; we center so it drops into the existing renderer
 *  which positions by node center. */
export function fromElkGraph(
  laid: { children?: ElkLaidNode[] } | null | undefined,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const c of laid?.children ?? []) {
    out.set(c.id, {
      x: (c.x ?? 0) + (c.width ?? 0) / 2,
      y: (c.y ?? 0) + (c.height ?? 0) / 2,
    });
  }
  return out;
}

/** LLM-emitted diagram graph via tool-use (B13).
 *
 * The plan: the LLM NEVER emits Mermaid (it reliably breaks the
 * syntax) — it calls a tool with a structured graph. An `intent`
 * field is filled BEFORE the graph (think-then-commit) and a
 * `layout` discriminator picks the renderer. The raw tool output is
 * NEVER trusted: `validateDiagramGraph` hard-validates it (this is
 * the "Zod-validated" requirement realized as a pure validator,
 * consistent with the codebase's JSON-schema tool pattern — no new
 * dep). Edges referencing unknown nodes are DROPPED, not rendered:
 * the model cannot draw an edge to a node it didn't declare (same
 * no-hallucination principle as B12).
 */

export type DiagramLayout = 'radial' | 'flow' | 'sequence' | 'deps';
const LAYOUTS: DiagramLayout[] = ['radial', 'flow', 'sequence', 'deps'];

export const DIAGRAM_TOOL = {
  name: 'emit_diagram',
  description:
    'Emit a structured diagram graph. Fill `intent` first (one line: what this diagram is FOR), then `layout`, then nodes/edges. Never use Mermaid.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      intent: { type: 'string', description: 'One line: what this diagram communicates (think-then-commit)' },
      layout: { type: 'string', enum: LAYOUTS, description: 'Which renderer/layout' },
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['id', 'label'],
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['source', 'target'],
        },
      },
    },
    required: ['intent', 'layout', 'nodes'],
  },
};

export interface DiagramGraph {
  intent: string;
  layout: DiagramLayout;
  nodes: { id: string; label: string }[];
  edges: { source: string; target: string; label?: string }[];
}

export type ValidateResult =
  | { ok: true; graph: DiagramGraph; dropped: string[] }
  | { ok: false; errors: string[] };

/** Hard-validate raw tool output. Pure + deterministic. Drops (does
 *  not reject) edges to unknown nodes so a mostly-good graph still
 *  renders, but records what was dropped for tracing. */
export function validateDiagramGraph(raw: unknown): ValidateResult {
  const errors: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;

  const intent = typeof r.intent === 'string' ? r.intent.trim() : '';
  if (!intent) errors.push('missing intent (think-then-commit field)');

  const layout = r.layout;
  if (typeof layout !== 'string' || !LAYOUTS.includes(layout as DiagramLayout)) {
    errors.push(`invalid layout (expected one of ${LAYOUTS.join('|')})`);
  }

  const rawNodes = Array.isArray(r.nodes) ? r.nodes : null;
  if (!rawNodes || rawNodes.length === 0) errors.push('no nodes');

  if (errors.length > 0) return { ok: false, errors };

  const seen = new Set<string>();
  const nodes: DiagramGraph['nodes'] = [];
  for (const n of rawNodes as Record<string, unknown>[]) {
    const id = typeof n.id === 'string' ? n.id : '';
    const label = typeof n.label === 'string' ? n.label : '';
    if (!id || seen.has(id)) continue; // skip blank / duplicate ids
    seen.add(id);
    nodes.push({ id, label: label || id });
  }
  if (nodes.length === 0) return { ok: false, errors: ['no valid nodes after sanitising'] };

  const dropped: string[] = [];
  const edges: DiagramGraph['edges'] = [];
  for (const e of (Array.isArray(r.edges) ? r.edges : []) as Record<string, unknown>[]) {
    const source = typeof e.source === 'string' ? e.source : '';
    const target = typeof e.target === 'string' ? e.target : '';
    if (seen.has(source) && seen.has(target)) {
      edges.push({ source, target, label: typeof e.label === 'string' ? e.label : undefined });
    } else {
      dropped.push(`${source || '?'}→${target || '?'}`);
    }
  }

  return {
    ok: true,
    graph: { intent, layout: layout as DiagramLayout, nodes, edges },
    dropped,
  };
}

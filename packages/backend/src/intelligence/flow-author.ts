/** Author a flow diagram from a free-form target, grounded in real evidence.
 *  Extracted from the visualize skill so the warmer can pre-author flows too.
 *
 *  Pipeline: prompt (with an EVIDENCE block of real files + import edges) →
 *  structured LLM call → shape-filter → validateFlow (ground nodes, support
 *  edges, drop orphans) → repair narration if it names a non-node. Returns
 *  null on failure so the caller can fall back to prose (voice north-star).
 */
import { validateFlow, type FlowEvidence, type AuthoredFlow } from './flow-validate.js';

export type FlowKind = 'pipeline' | 'sequence' | 'graph' | 'tree';
const KIND_VALUES: readonly FlowKind[] = ['pipeline', 'sequence', 'graph', 'tree'];
const NODE_ROLES = ['source', 'transform', 'guard', 'sink'] as const;

export interface AuthoredDiagramRaw {
  narration: string;
  kind: FlowKind;
  title: string;
  subtitle: string;
  nodes: Array<{ id: string; label: string; description?: string; role?: string; evidenceFile?: string; conceptual?: boolean }>;
  edges: Array<{ from: string; to: string; kind?: string; label?: string; inferred?: boolean }>;
}

export interface FlowAuthorResult {
  kind: FlowKind;
  title: string;
  subtitle: string;
  narration: string;
  nodes: AuthoredDiagramRaw['nodes'];
  edges: AuthoredDiagramRaw['edges'];
}

/** Minimal analyzer surface flow-author needs — keeps it mock-testable. */
export interface FlowAuthorAnalyzer {
  structuredCallDirect<T>(params: { prompt: string; toolName: string; toolDescription: string; inputSchema: unknown }): Promise<T>;
}

export interface AuthorFlowInput {
  target: string;
  projectContext: string;
  brevity?: string;
  /** Real files + import edges for the target module, or null if unresolved. */
  evidence: FlowEvidence | null;
  analyzer: FlowAuthorAnalyzer;
}

const AUTHORED_DIAGRAM_SCHEMA = {
  type: 'object' as const,
  properties: {
    narration: { type: 'string', description: '3-5 sentences spoken aloud; refer to nodes by their labels ONLY (never name a component that is not a node).' },
    kind: { type: 'string', enum: KIND_VALUES as unknown as string[] },
    title: { type: 'string', description: 'Short header (≤ 6 words)' },
    subtitle: { type: 'string', description: 'One-line description' },
    nodes: {
      type: 'array', minItems: 3, maxItems: 9,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case stable id' },
          label: { type: 'string', description: 'Short on-node label, ≤ 3 words' },
          description: { type: 'string', description: 'One short line shown under the label' },
          role: { type: 'string', enum: NODE_ROLES as unknown as string[] },
          evidenceFile: { type: 'string', description: 'The exact file from the EVIDENCE list this node represents, or omit if it is a concept.' },
          conceptual: { type: 'boolean', description: 'true if this node is a concept, not a specific file.' },
        },
        required: ['id', 'label'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' }, to: { type: 'string' },
          kind: { type: 'string' }, label: { type: 'string' },
          inferred: { type: 'boolean', description: 'true if this connection is inferred, not backed by a listed import.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  required: ['narration', 'kind', 'title', 'subtitle', 'nodes', 'edges'],
};

function evidenceBlock(ev: FlowEvidence | null): string {
  if (!ev || ev.files.length === 0) return '';
  const fileLines = ev.files.map(f => `  - ${f}`).join('\n');
  const edgeLines = ev.importEdges.length
    ? ev.importEdges.map(e => `  - ${e.from} → ${e.to}`).join('\n')
    : '  (none parsed)';
  return [
    `\n\nEVIDENCE — the REAL files in this module:`,
    fileLines,
    `\nObserved import edges (one file importing another):`,
    edgeLines,
    `\nRULES: every node must correspond to one of the files above (set its` +
    ` evidenceFile) OR be marked conceptual:true. Every edge must be justified` +
    ` by a listed import edge OR marked inferred:true. The narration must refer` +
    ` ONLY to nodes you actually create.`,
  ].join('\n');
}

export async function authorFlow(input: AuthorFlowInput): Promise<FlowAuthorResult | null> {
  const { target, projectContext, brevity, evidence, analyzer } = input;
  const prompt = [
    `Author a diagram that visually answers: "${target}".`,
    `Pick the KIND that best fits:`,
    `  - "pipeline": linear stages, data flowing through (use for "show me the flow").`,
    `  - "sequence": ordered interactions / call sequence.`,
    `  - "tree": hierarchy / containment.`,
    `  - "graph": general dependency / relationship graph.`,
    `Choose 3-9 nodes the answer NEEDS the user to see — concrete things from this`,
    `codebase, not abstract placeholders. Short label (≤3 words) + one-line description.`,
    `Connect them with edges that match the kind (pipeline: source → … → sink). Roles:`,
    `source (entry/input), transform (processing), guard (validation/policy), sink (output/effect).`,
    `Then narrate it — the spoken text MUST refer to the nodes by their labels.`,
    brevity ?? '',
    projectContext,
    evidenceBlock(evidence),
  ].filter(Boolean).join(' ');

  let out: AuthoredDiagramRaw;
  try {
    out = await analyzer.structuredCallDirect<AuthoredDiagramRaw>({
      prompt,
      toolName: 'author_diagram',
      toolDescription: 'Return a diagram (kind, nodes, edges, title, subtitle) plus the spoken narration that describes it.',
      inputSchema: AUTHORED_DIAGRAM_SCHEMA,
    });
  } catch {
    return null;
  }

  const kind: FlowKind = KIND_VALUES.includes(out.kind) ? out.kind : 'graph';
  const nodes = (out.nodes ?? [])
    .filter(n => n && typeof n.id === 'string' && typeof n.label === 'string' && n.id.trim() && n.label.trim())
    .map(n => ({
      id: n.id.trim(),
      label: n.label.trim(),
      description: typeof n.description === 'string' ? n.description.trim() : undefined,
      role: typeof n.role === 'string' && (NODE_ROLES as readonly string[]).includes(n.role) ? n.role : undefined,
      evidenceFile: typeof n.evidenceFile === 'string' ? n.evidenceFile.trim() : undefined,
      conceptual: n.conceptual === true,
    }));
  const validIds = new Set(nodes.map(n => n.id));
  const edges = (out.edges ?? [])
    .filter(e => e && validIds.has(e.from) && validIds.has(e.to) && e.from !== e.to)
    .map(e => ({
      from: e.from, to: e.to,
      kind: typeof e.kind === 'string' ? e.kind : undefined,
      label: typeof e.label === 'string' ? e.label : undefined,
      inferred: e.inferred === true,
    }));

  if (nodes.length < 3) return null;

  let narration = (out.narration ?? '').trim();
  let finalNodes = nodes;
  let finalEdges = edges;

  // Grounding pass — only when we actually have evidence to check against.
  if (evidence && evidence.files.length > 0) {
    const validated = validateFlow({ nodes, edges, narration } as AuthoredFlow, evidence);
    if (validated.nodes.length >= 3) {
      finalNodes = validated.nodes as typeof nodes;
      finalEdges = validated.edges as typeof edges;
      if (!validated.narrationOk) {
        narration = templateNarration(out.title ?? target, finalNodes);
      }
    }
  }

  return {
    kind,
    title: (out.title ?? target).trim(),
    subtitle: (out.subtitle ?? '').trim(),
    narration,
    nodes: finalNodes,
    edges: finalEdges,
  };
}

/** Deterministic narration when the LLM's words named a node that doesn't
 *  exist — describe the flow using ONLY the authored labels. */
function templateNarration(title: string, nodes: AuthoredDiagramRaw['nodes']): string {
  const byRole = (r: string) => nodes.filter(n => n.role === r).map(n => n.label);
  const sources = byRole('source');
  const sinks = byRole('sink');
  const mids = nodes.filter(n => n.role !== 'source' && n.role !== 'sink').map(n => n.label);
  const parts: string[] = [];
  if (sources.length) parts.push(`${title} starts from ${list(sources)}`);
  else parts.push(title);
  if (mids.length) parts.push(`runs through ${list(mids)}`);
  if (sinks.length) parts.push(`and ends at ${list(sinks)}`);
  return parts.join(', ').replace(/,\s*and/, ' and') + '.';
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

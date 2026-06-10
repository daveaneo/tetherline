import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction } from './params-helper.js';

type Kind = 'pipeline' | 'sequence' | 'graph' | 'tree';

interface AuthoredNode {
  id: string;
  label: string;
  description?: string;
  role?: string;
}
interface AuthoredEdge {
  from: string;
  to: string;
  kind?: string;
  label?: string;
}
interface AuthoredDiagram {
  narration: string;
  kind: Kind;
  title: string;
  subtitle: string;
  nodes: AuthoredNode[];
  edges: AuthoredEdge[];
}

const KIND_VALUES: readonly Kind[] = ['pipeline', 'sequence', 'graph', 'tree'];
const NODE_ROLES = ['source', 'transform', 'guard', 'sink'] as const;

const AUTHORED_DIAGRAM_SCHEMA = {
  type: 'object' as const,
  properties: {
    narration: {
      type: 'string',
      description:
        '3-5 sentences spoken aloud naturally, describing the diagram the user is now looking at. Refer to the nodes by their labels.',
    },
    kind: { type: 'string', enum: KIND_VALUES as unknown as string[] },
    title: { type: 'string', description: 'Short header for the diagram (≤ 6 words)' },
    subtitle: { type: 'string', description: 'One-line description; what this diagram shows' },
    nodes: {
      type: 'array',
      minItems: 3,
      maxItems: 9,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case stable id' },
          label: { type: 'string', description: 'Short on-node label, ≤ 3 words' },
          description: { type: 'string', description: 'One short line shown under the label' },
          role: { type: 'string', enum: NODE_ROLES as unknown as string[] },
        },
        required: ['id', 'label'],
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['from', 'to'],
      },
    },
  },
  required: ['narration', 'kind', 'title', 'subtitle', 'nodes', 'edges'],
};

export const visualizeSkill: Skill = {
  name: 'visualize',
  description: 'Author a fresh diagram that answers a visual question (pipeline / flow / architecture)',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.subject ?? params.scope ?? 'the current code';
    const projectContext = [
      `Repo: ${context.repoPath}.`,
      `Top-level areas: ${context.areas.map(a => `${a.name} — ${a.description ?? ''}`.trim()).join('; ') || 'unknown'}.`,
      context.currentArea ? `Currently focused area: ${context.currentArea.name}.` : '',
    ].filter(Boolean).join(' ');

    const brevity = constraintInstruction(
      params,
      ['target', 'subject', 'scope'],
      'Spoken naturally; refer to nodes by their labels so the words and the picture agree.',
    );

    const prompt = [
      `Author a diagram that visually answers: "${target}".`,
      `Pick the diagram KIND that best fits the question:`,
      `  - "pipeline": linear stages, data flowing through (use for "show me the flow", "how does data move").`,
      `  - "sequence": ordered interactions over time / call sequence.`,
      `  - "tree": hierarchy / containment.`,
      `  - "graph": general dependency / relationship graph.`,
      `Choose 3-9 nodes that the answer NEEDS the user to see — concrete things from this codebase,`,
      `not abstract placeholders. Give each node a short label (≤3 words) and one-line description.`,
      `Connect them with edges that match the kind (pipeline: source → ... → sink). Roles:`,
      `source (entry/input), transform (processing), guard (validation/policy), sink (output/effect).`,
      `Then narrate it — the spoken text MUST refer to the nodes by their labels so what the user`,
      `hears matches what's on screen.`,
      brevity,
      projectContext,
    ].join(' ');

    try {
      const out = await context.analyzer.structuredCallDirect<AuthoredDiagram>({
        prompt,
        toolName: 'author_diagram',
        toolDescription:
          'Return a diagram (kind, nodes, edges, title, subtitle) plus the spoken narration that describes it.',
        inputSchema: AUTHORED_DIAGRAM_SCHEMA,
      });

      const kind: Kind = KIND_VALUES.includes(out.kind) ? out.kind : 'graph';
      const nodes = (out.nodes ?? [])
        .filter(n => n && typeof n.id === 'string' && typeof n.label === 'string' && n.id.trim() && n.label.trim())
        .map(n => ({
          id: n.id.trim(),
          label: n.label.trim(),
          description: typeof n.description === 'string' ? n.description.trim() : undefined,
          role: typeof n.role === 'string' && (NODE_ROLES as readonly string[]).includes(n.role) ? n.role : undefined,
        }));
      const validIds = new Set(nodes.map(n => n.id));
      const edges = (out.edges ?? [])
        .filter(e => e && validIds.has(e.from) && validIds.has(e.to) && e.from !== e.to)
        .map(e => ({
          from: e.from,
          to: e.to,
          kind: typeof e.kind === 'string' ? e.kind : undefined,
          label: typeof e.label === 'string' ? e.label : undefined,
        }));

      if (nodes.length < 3) throw new Error('authored diagram too thin');

      const diagram = {
        // `authored/<target>` so the frontend recognises it as a
        // transient overlay (not a cached scope it should refetch).
        scope: `authored/${target.toLowerCase().replace(/\s+/g, '-').slice(0, 40)}`,
        view: 'logic' as const,
        title: (out.title ?? target).trim(),
        subtitle: (out.subtitle ?? '').trim(),
        nodes,
        edges,
      };

      return {
        skillName: 'visualize',
        type: 'diagram',
        narration: (out.narration ?? '').trim(),
        // The frontend swaps in `visualPayload.diagram` for the
        // lifetime of this skill result. `kind` is a layout hint
        // for future use; today the radial layout handles all kinds.
        visualPayload: { target, kind, diagram },
      };
    } catch {
      // Voice north-star: never go silent. Fall back to the prior
      // narrate-only path so spoken UX degrades gracefully.
      const narration = await context.analyzer.answerQuestion(
        `Describe the visual structure of ${target} for a diagram. What are the key components and how do they connect? Keep it brief — this will be narrated aloud.`,
        `Repo: ${context.repoPath}. Areas: ${context.areas.map(a => a.name).join(', ')}.`,
        { params, currentFile: context.currentFile },
      );
      return {
        skillName: 'visualize',
        type: 'diagram',
        narration,
        visualPayload: { target },
      };
    }
  },
};

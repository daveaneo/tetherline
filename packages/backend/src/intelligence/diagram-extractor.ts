/**
 * Diagram extractor — turns the cached project / module summaries
 * into ready-to-render diagram payloads (nodes + edges) for both
 * views.
 *
 * - **File view**: derived without an LLM call. Workspace +
 *   import-edge data already in the cache becomes nodes/edges
 *   directly. Cheap, deterministic, fast.
 * - **Logic view**: LLM-derived. We ask for a small JSON describing
 *   the conceptual pipeline (producers / consumers / transforms /
 *   guards). Cassette-able. Fall back to a "logic === file" mirror
 *   if no adapter is available, so warmers without an API key still
 *   produce SOMETHING usable rather than nothing.
 */
import { createHash } from 'crypto';
import type { ContextCacheRepository, ModuleCacheRow } from '../db/repositories/context-cache-repo.js';
import type { ComprehensionRepository } from '../db/repositories/comprehension-repo.js';
import type { DiagramRow, DiagramNode, DiagramEdge } from '../db/repositories/diagram-cache-repo.js';
import type { LLMAdapter } from './llm/index.js';

export interface ExtractParams {
  repoPath: string;
  cacheRepo: ContextCacheRepository;
  comprehensionRepo?: ComprehensionRepository;
  adapter: LLMAdapter | null;
}

const MAX_SATELLITES = 6;
// Bump this whenever the diagram payload SHAPE changes (new node fields,
// new edge kinds, layout-affecting logic). Mixed into every source hash
// so cached rows from prior shapes get re-warmed automatically.
const DIAGRAM_SCHEMA_VERSION = 'v4-no-ellipsis-subtitle';

/** Project-level FILE view — top-level modules orbit the project. */
export function extractProjectFileView(p: ExtractParams): DiagramRow {
  const project = p.cacheRepo.getProject(p.repoPath);
  const modules = topModules(p.cacheRepo, p.repoPath);
  const compMap = comprehensionMap(p.repoPath, p.comprehensionRepo);

  const projectName = project?.summary ? extractName(project.summary, p.repoPath) : basename(p.repoPath);

  const center: DiagramNode = {
    id: 'project',
    label: projectName,
    description: oneLineDescription(project?.purpose, project?.summary),
    role: 'source',
    weight: 1,
    ...comp(compMap, 'project'),
    briefingId: 'project',
  };
  const satellites: DiagramNode[] = modules.map(m => ({
    id: `module/${m.modulePath}`,
    label: m.modulePath,
    description: oneLineDescription(undefined, m.summary),
    role: 'transform',
    weight: normalizeWeight(m.impactScore, modules),
    ...comp(compMap, `module/${m.modulePath}`),
    briefingId: `module/${m.modulePath}`,
  }));

  // Edges: ALWAYS connect center→satellite (parent-of relationship)
  // so the canvas never floats with disconnected nodes. Cross-module
  // imports layer on top with a stronger style.
  const ids = new Set([center.id, ...satellites.map(s => s.id)]);
  const edges: DiagramEdge[] = satellites.map(s => ({
    from: center.id, to: s.id, kind: 'contains' as const,
  }));
  for (const m of modules) {
    for (const target of m.imports ?? []) {
      const targetId = `module/${target}`;
      if (!ids.has(targetId)) continue;
      edges.push({ from: `module/${m.modulePath}`, to: targetId, kind: 'imports' });
    }
  }

  return {
    repoPath: p.repoPath,
    scope: 'project',
    view: 'file',
    title: projectName,
    subtitle: oneLineDescription(project?.purpose, project?.summary) ?? `${modules.length} top-level modules`,
    nodes: [center, ...satellites],
    edges,
    sourceHash: hashOf([
      DIAGRAM_SCHEMA_VERSION,
      projectName,
      ...modules.map(m => `${m.modulePath}:${m.impactScore}:${(m.imports ?? []).join(',')}`),
    ]),
    generatedAt: new Date().toISOString(),
  };
}

/** Per-module FILE view — files inside the module orbit the module. */
export function extractModuleFileView(p: ExtractParams, modulePath: string): DiagramRow | null {
  const mod = p.cacheRepo.getModule(p.repoPath, modulePath);
  if (!mod) return null;
  const compMap = comprehensionMap(p.repoPath, p.comprehensionRepo);
  const keyFiles = (mod.keyFiles ?? []).slice(0, MAX_SATELLITES);

  const center: DiagramNode = {
    id: `module/${modulePath}`,
    label: modulePath,
    description: oneLineDescription(undefined, mod.summary),
    role: 'transform',
    weight: 1,
    ...comp(compMap, `module/${modulePath}`),
    briefingId: `module/${modulePath}`,
  };
  const satellites: DiagramNode[] = keyFiles.map(f => ({
    id: `file/${f}`,
    label: basename(f),
    description: f,
    role: 'transform',
    weight: 0.6,
    ...comp(compMap, `file/${f}`),
    briefingId: `file/${f}`,
  }));

  return {
    repoPath: p.repoPath,
    scope: `module/${modulePath}`,
    view: 'file',
    title: modulePath,
    subtitle: oneLineDescription(undefined, mod.summary) ?? `${keyFiles.length} key files`,
    nodes: [center, ...satellites],
    // center→file containment edges so the canvas isn't disconnected.
    edges: satellites.map(s => ({ from: center.id, to: s.id, kind: 'contains' as const })),
    sourceHash: hashOf([DIAGRAM_SCHEMA_VERSION, modulePath, mod.summary, ...keyFiles]),
    generatedAt: new Date().toISOString(),
  };
}

/** LLM-derived LOGIC view for the project. Falls back to a file-view
 *  mirror if no adapter is available, so callers always get a
 *  diagram. */
export async function extractProjectLogicView(p: ExtractParams): Promise<DiagramRow> {
  const fileView = extractProjectFileView(p);
  if (!p.adapter) return { ...fileView, view: 'logic' };

  const project = p.cacheRepo.getProject(p.repoPath);
  const modules = topModules(p.cacheRepo, p.repoPath);
  if (!project || modules.length === 0) return { ...fileView, view: 'logic' };

  const result = await callLogicGraphLLM(p.adapter, {
    projectName: fileView.title,
    projectSummary: project.summary,
    modules: modules.map(m => ({ name: m.modulePath, summary: m.summary, imports: m.imports ?? [] })),
  });
  if (!result) return { ...fileView, view: 'logic' };

  // Anchor the LLM's nodes back to comprehension / briefing data so
  // halos and click-to-utterance keep working.
  const compMap = comprehensionMap(p.repoPath, p.comprehensionRepo);
  const moduleNames = new Set(modules.map(m => m.modulePath));
  const enriched: DiagramNode[] = result.nodes.map(n => {
    // If the LLM's node name matches a real module, anchor it.
    const matchedModule = [...moduleNames].find(name => n.label.toLowerCase().includes(name.toLowerCase()));
    return {
      ...n,
      ...(matchedModule
        ? comp(compMap, `module/${matchedModule}`)
        : { level: undefined, grilled: false, quizCorrect: 0, quizTotal: 0, grillStrong: 0, grillAsked: 0 }),
      briefingId: matchedModule ? `module/${matchedModule}` : undefined,
    };
  });

  return {
    repoPath: p.repoPath,
    scope: 'project',
    view: 'logic',
    title: fileView.title,
    subtitle: oneLineDescription(project.purpose, project.summary) ?? fileView.subtitle,
    nodes: enriched,
    edges: result.edges,
    sourceHash: hashOf([
      DIAGRAM_SCHEMA_VERSION,
      fileView.title,
      project.summary,
      ...result.nodes.map(n => `${n.id}:${n.label}`),
      ...result.edges.map(e => `${e.from}->${e.to}`),
    ]),
    generatedAt: new Date().toISOString(),
  };
}

/** Per-module LOGIC view. Falls back to file-view mirror without an adapter. */
export async function extractModuleLogicView(
  p: ExtractParams, modulePath: string,
): Promise<DiagramRow | null> {
  const fileView = extractModuleFileView(p, modulePath);
  if (!fileView) return null;
  if (!p.adapter) return { ...fileView, view: 'logic' };

  const mod = p.cacheRepo.getModule(p.repoPath, modulePath);
  if (!mod) return { ...fileView, view: 'logic' };

  const fileSummaries = (mod.keyFiles ?? []).map(f => {
    const fileRow = p.cacheRepo.getFile(p.repoPath, f);
    return { path: f, summary: fileRow?.summary ?? '' };
  });

  const result = await callLogicGraphLLM(p.adapter, {
    projectName: modulePath,
    projectSummary: mod.summary,
    modules: fileSummaries.map(f => ({ name: f.path, summary: f.summary, imports: [] })),
  });
  if (!result) return { ...fileView, view: 'logic' };

  return {
    ...fileView,
    view: 'logic',
    nodes: result.nodes,
    edges: result.edges,
    sourceHash: hashOf([
      DIAGRAM_SCHEMA_VERSION, modulePath, mod.summary,
      ...result.nodes.map(n => `${n.id}:${n.label}`),
      ...result.edges.map(e => `${e.from}->${e.to}`),
    ]),
  };
}

// ─────────────────────────────────────────────────────────────────────
// LLM call — structured JSON via the tool-use facility.
// ─────────────────────────────────────────────────────────────────────

interface LogicGraphInput {
  projectName: string;
  projectSummary: string;
  modules: Array<{ name: string; summary: string; imports: string[] }>;
}

async function callLogicGraphLLM(
  adapter: LLMAdapter,
  input: LogicGraphInput,
): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] } | null> {
  const userPrompt = [
    `Identify the conceptual pipeline of "${input.projectName}". Return a small graph (≤7 nodes) describing the logical flow — NOT the file structure. Each node is a stage in a story you'd tell a senior engineer in 30 seconds.`,
    '',
    `Project summary: ${input.projectSummary}`,
    '',
    'Modules and their summaries (these are the implementation, not the concepts):',
    ...input.modules.map(m =>
      `- ${m.name}${m.imports.length > 0 ? ` (imports from: ${m.imports.join(', ')})` : ''}: ${m.summary}`,
    ),
    '',
    'Each node:',
    '- id: short slug (e.g. "ingest", "training-pairs", "perplexity-guard")',
    '- label: 1–3 word display title',
    '- description: one line, ≤80 chars, what this stage IS',
    '- role: one of "source", "transform", "guard", "sink"',
    '- implementsFiles: which module names from the list above this concept lives in (≥1)',
    '',
    'Each edge:',
    '- from / to: node ids',
    '- kind: "produces" (data flow), "consumes" (input), "configures" (settings flow), "guards" (validation)',
    '- label: optional short label, only when it adds clarity',
    '',
    'Output the graph that tells the project\'s story most clearly. Prefer FEWER nodes done well over many vague ones.',
  ].join('\n');

  try {
    const resp = await adapter.complete({
      model: 'claude-sonnet-4-20250514',
      system: 'You extract conceptual pipelines from project descriptions. Output valid JSON via the tool. Be specific — never produce generic nodes like "input" or "processing".',
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 1500,
      tool: {
        name: 'emit_logic_graph',
        description: 'Emit the project\'s conceptual pipeline as a directed graph.',
        inputSchema: {
          type: 'object',
          required: ['nodes', 'edges'],
          properties: {
            nodes: {
              type: 'array',
              minItems: 2,
              maxItems: 7,
              items: {
                type: 'object',
                required: ['id', 'label', 'description', 'role'],
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                  role: { type: 'string', enum: ['source', 'transform', 'guard', 'sink'] },
                  implementsFiles: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            edges: {
              type: 'array',
              items: {
                type: 'object',
                required: ['from', 'to', 'kind'],
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  kind: { type: 'string', enum: ['produces', 'consumes', 'configures', 'guards'] },
                  label: { type: 'string' },
                },
              },
            },
          },
        },
      },
    });
    const tool = resp.toolInput as { nodes: DiagramNode[]; edges: DiagramEdge[] } | undefined;
    if (!tool?.nodes || !tool?.edges) return null;
    return { nodes: tool.nodes, edges: tool.edges };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function topModules(repo: ContextCacheRepository, repoPath: string): ModuleCacheRow[] {
  return repo.getModulesForRepo(repoPath)
    .filter(m => m.confidence >= 0.3)
    .sort((a, b) => (b.impactScore - a.impactScore) || (b.confidence - a.confidence))
    .slice(0, MAX_SATELLITES);
}

interface CompCell {
  level: DiagramNode['level'];
  grilled: boolean;
  quizCorrect: number;
  quizTotal: number;
  grillStrong: number;
  grillAsked: number;
}

function comprehensionMap(
  repoPath: string,
  repo?: ComprehensionRepository,
): Map<string, CompCell> {
  const out = new Map<string, CompCell>();
  if (!repo) return out;
  for (const item of repo.getAll(repoPath)) {
    out.set(item.itemId, {
      level: item.level as DiagramNode['level'],
      grilled: item.grilled === true,
      quizCorrect: item.quizCorrect ?? 0,
      quizTotal: item.quizTotal ?? 0,
      grillStrong: item.grillStrong ?? 0,
      grillAsked: item.grillAsked ?? 0,
    });
  }
  return out;
}

/** Spread the comprehension cell for `key` onto a node literal:
 *  `{ ...comp(map, key) }` → level + grilled + v2 ratios. */
function comp(map: Map<string, CompCell>, key: string): Omit<CompCell, never> {
  const c = map.get(key);
  return {
    level: c?.level,
    grilled: c?.grilled ?? false,
    quizCorrect: c?.quizCorrect ?? 0,
    quizTotal: c?.quizTotal ?? 0,
    grillStrong: c?.grillStrong ?? 0,
    grillAsked: c?.grillAsked ?? 0,
  };
}

function normalizeWeight(impact: number, all: ModuleCacheRow[]): number {
  const max = Math.max(1, ...all.map(m => m.impactScore));
  return 0.4 + (impact / max) * 0.6; // 0.4..1.0
}

function oneLineDescription(purpose: string | undefined, summary: string | undefined): string | undefined {
  const candidate = (purpose || summary || '').trim();
  if (!candidate) return undefined;
  // Strip markdown noise + take the first sentence. The cap was 80 chars
  // which truncated even single grammatical sentences ("The core module
  // is the data-pipeline and hardware-intelligence backbone of
  // PersonalForge." = 92 chars) and appended "…". The diagram and the
  // header BOTH wrap text now, so the cap is loosened — give the
  // sentence room to breathe across 2-3 wrapped lines instead of
  // chopping it mid-thought.
  const cleaned = candidate.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  const firstSentence = cleaned.match(/^[^.!?]{8,220}[.!?]/)?.[0] ?? cleaned;
  if (firstSentence.length <= 200) return firstSentence.trim();
  // Only truncate when the first "sentence" is genuinely runaway prose
  // (>200 chars with no period). Hard-cut at the last word boundary —
  // still no ellipsis, since the rendering layer wraps multi-line and
  // the trailing "…" is visual noise the user explicitly didn't want.
  const truncated = firstSentence.slice(0, 200);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 100 ? truncated.slice(0, lastSpace) : truncated).trim();
}

function extractName(summary: string, repoPath: string): string {
  const m = summary.match(/^([A-Z][\w-]*(?:\s+[A-Z][\w-]*)?)\s+(?:is|—|-)/);
  if (m && m[1].length < 40) return m[1].trim();
  return basename(repoPath);
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

function hashOf(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

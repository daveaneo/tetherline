/** Ground an LLM-authored flow diagram against the real files + import graph.
 *  Pure — table-testable, no DB/LLM. The visualize skill authors nodes/edges
 *  from module summaries (it never sees code), so it guesses; this is the
 *  honesty pass that turns guesses into clearly-marked evidence:
 *    - node → real file (fuzzy) or `conceptual` (dotted outline),
 *    - edge supported by an import → solid; unsupported but grounded → dashed
 *      `inferred`; neither end grounded → dropped,
 *    - degree-0 node dropped while ≥3 remain,
 *    - narration naming a component with no node → narrationOk=false (repair).
 */

export interface FlowEvidence {
  moduleName: string;
  /** Repo-relative file paths that belong to the target module. */
  files: string[];
  /** File-level import edges within the module (either direction is support). */
  importEdges: Array<{ from: string; to: string }>;
}

export interface AuthoredNode {
  id: string;
  label: string;
  description?: string;
  role?: string;
  /** Set by the LLM or filled here when a node grounds to a real file. */
  evidenceFile?: string;
  /** No real file backs this node — render dotted, mark "concept". */
  conceptual?: boolean;
}
export interface AuthoredEdge {
  from: string;
  to: string;
  kind?: string;
  label?: string;
  /** The import graph doesn't back this edge — render faint + dashed. */
  inferred?: boolean;
}
export interface AuthoredFlow {
  nodes: AuthoredNode[];
  edges: AuthoredEdge[];
  narration: string;
}
export interface ValidatedFlow {
  nodes: AuthoredNode[];
  edges: AuthoredEdge[];
  /** False ⇒ narration names a component that isn't a node — caller repairs. */
  narrationOk: boolean;
  /** Node ids removed as ungrounded orphans (logged, not silent). */
  dropped: string[];
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'file', 'files',
  'module', 'src', 'lib', 'index', 'main', 'py', 'ts', 'js', 'tsx', 'jsx',
  'a', 'an', 'of', 'to', 'in', 'on', 'core', 'app', 'utils', 'util',
]);

/** Tokenize an identifier/path/label into comparable lowercase word tokens:
 *  strips extension + directories, splits snake/kebab/dotted AND camelCase,
 *  drops stop-words and 1-char fragments. `data_cleaner.py`, `DataCleaner`,
 *  and `personalforge.collectors.data_cleaner` all share the `cleaner` token. */
export function normalizeTokens(raw: string): Set<string> {
  const base = raw.replace(/\.[a-z0-9]+$/i, ''); // drop a trailing extension
  const parts = base
    .split(/[/\\._\-\s]+/)
    .flatMap(p => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/));
  const out = new Set<string>();
  for (const p of parts) {
    const t = p.toLowerCase().trim();
    if (t.length < 2 || STOP.has(t)) continue;
    out.add(t);
  }
  return out;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (t.length > 2 && b.has(t)) return true;
  return false;
}

/** Best evidence file for a node label — the file whose token set overlaps. */
function matchFile(label: string, files: string[]): string | null {
  const lt = normalizeTokens(label);
  for (const f of files) {
    if (overlaps(lt, normalizeTokens(f))) return f;
  }
  return null;
}

export function validateFlow(authored: AuthoredFlow, evidence: FlowEvidence): ValidatedFlow {
  // 1. Ground each node to a real file, else mark conceptual.
  const nodes: AuthoredNode[] = authored.nodes.map(n => {
    const file =
      (n.evidenceFile && evidence.files.includes(n.evidenceFile) ? n.evidenceFile : null) ??
      matchFile(n.label, evidence.files);
    if (file) return { ...n, evidenceFile: file, conceptual: false };
    return { ...n, evidenceFile: undefined, conceptual: true };
  });
  const byId = new Map(nodes.map(n => [n.id, n]));

  // 2. Support index: a file-pair (either direction) backed by an import.
  const supported = new Set<string>();
  for (const e of evidence.importEdges) {
    supported.add(`${e.from}|${e.to}`);
    supported.add(`${e.to}|${e.from}`);
  }

  const edges: AuthoredEdge[] = [];
  for (const e of authored.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b || e.from === e.to) continue;
    const aFile = a.evidenceFile;
    const bFile = b.evidenceFile;
    if (!aFile && !bFile) continue; // neither end real → drop the guess
    const isSupported = aFile != null && bFile != null && supported.has(`${aFile}|${bFile}`);
    edges.push({ ...e, inferred: !isSupported });
  }

  // 3. Drop degree-0 orphans while ≥3 nodes remain (input order, stable).
  const degree = new Map<string, number>(nodes.map(n => [n.id, 0]));
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const dropped: string[] = [];
  const kept: AuthoredNode[] = [];
  for (const n of nodes) {
    if ((degree.get(n.id) ?? 0) === 0 && nodes.length - dropped.length > 3) {
      dropped.push(n.id);
    } else {
      kept.push(n);
    }
  }
  const keptIds = new Set(kept.map(n => n.id));
  const keptEdges = edges.filter(e => keptIds.has(e.from) && keptIds.has(e.to));

  // 4. Narration contract: any CamelCase component name spoken must be a node.
  const narrationOk = narrationReferencesOnlyNodes(authored.narration, kept);

  return { nodes: kept, edges: keptEdges, narrationOk, dropped };
}

/** Tech proper nouns that look like component names but are brands/languages —
 *  exempt so narration like "written in TypeScript" doesn't trip the check. */
const BRAND_WORDS = new Set([
  'typescript', 'javascript', 'github', 'gitlab', 'openai', 'postgresql', 'postgres',
  'mongodb', 'graphql', 'nodejs', 'huggingface', 'pytorch', 'tensorflow', 'kubernetes',
  'dynamodb', 'redis', 'sqlite', 'webgl', 'webrtc',
]);

/** A PascalCase identifier in the narration (FileLoader, GGUFWriter, HFStreamer)
 *  that doesn't match any node label means the words and the picture disagree.
 *  The pattern matches both camel humps (FileLoader) and acronym-prefixed
 *  compounds (GGUFWriter, HFStreamer, HWScanner). Plain prose ("converge",
 *  "sources") and single Capitalized words never trip it. */
function narrationReferencesOnlyNodes(narration: string, nodes: AuthoredNode[]): boolean {
  const labelTokens = nodes.map(n => normalizeTokens(n.label));
  const mentions = narration.match(/\b[A-Z][A-Za-z0-9]*[A-Z][a-z][A-Za-z0-9]*\b/g) ?? [];
  for (const m of mentions) {
    if (BRAND_WORDS.has(m.toLowerCase())) continue;
    const mt = normalizeTokens(m);
    if (mt.size === 0) continue;
    const covered = labelTokens.some(lt => overlaps(mt, lt));
    if (!covered) return false;
  }
  return true;
}

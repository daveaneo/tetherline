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
  /** Module files this stage owns (its evidence file + any that token-match
   *  it best) — drives the "contains N" pip + containment answers. */
  implementsFiles?: string[];
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
  /** Module files that map to no stage — surfaced so "+N more files" is honest
   *  rather than the diagram silently implying it shows everything. */
  unassignedFiles: string[];
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

function countOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (t.length > 2 && b.has(t)) n++;
  return n;
}

/** A node that represents the module itself rather than a stage within it
 *  ("Core Module" inside the core flow). Compared on stripped identifiers so
 *  the `core`/`module` stop-words (which normalizeTokens drops) still match. */
function isSelfNode(label: string, moduleName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ln = norm(label);
  const mn = norm(moduleName);
  if (!ln || !mn) return false;
  return ln === mn || ln === `${mn}module` || ln === `module${mn}`;
}

/** Assign each module file to the stage whose label+evidence best token-match
 *  it; stamp node.implementsFiles. Returns the files that matched no stage. */
function assignMembership(nodes: AuthoredNode[], files: string[]): string[] {
  const grounded = nodes.filter(n => n.evidenceFile);
  const nodeTokens = new Map(grounded.map(n => [n.id, normalizeTokens(`${n.label} ${n.evidenceFile ?? ''}`)]));
  const assigned = new Map<string, string[]>(grounded.map(n => [n.id, []]));
  const unassigned: string[] = [];
  for (const f of files) {
    const ft = normalizeTokens(f);
    let bestId: string | null = null;
    let bestScore = 0;
    for (const n of grounded) {
      const score = countOverlap(ft, nodeTokens.get(n.id)!);
      if (score > bestScore) { bestScore = score; bestId = n.id; }
    }
    if (bestId && bestScore > 0) assigned.get(bestId)!.push(f);
    else unassigned.push(f);
  }
  for (const n of nodes) {
    const own = assigned.get(n.id);
    if (own && own.length > 0) n.implementsFiles = own;
  }
  return unassigned;
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
  const grounded: AuthoredNode[] = authored.nodes.map(n => {
    const file =
      (n.evidenceFile && evidence.files.includes(n.evidenceFile) ? n.evidenceFile : null) ??
      matchFile(n.label, evidence.files);
    if (file) return { ...n, evidenceFile: file, conceptual: false };
    return { ...n, evidenceFile: undefined, conceptual: true };
  });
  // 1b. Drop a self-referential node (the module-as-its-own-stage, e.g.
  //     "Core Module" inside the core flow) — but only while ≥3 real stages
  //     would remain without it.
  const selfIds = new Set(grounded.filter(n => isSelfNode(n.label, evidence.moduleName)).map(n => n.id));
  const nonSelfCount = grounded.length - selfIds.size;
  const nodes: AuthoredNode[] = grounded.filter(n => !(selfIds.has(n.id) && nonSelfCount >= 3));
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

  // 4. Stage membership: assign every module file to the stage it best
  //    token-matches, so a stage can show "contains N" and containment
  //    questions ("is X inside these five?") have a structural answer. Files
  //    matching no stage are surfaced as unassigned ("+N more files").
  const unassignedFiles = assignMembership(kept, evidence.files);

  // 5. Narration contract: any CamelCase component name spoken must be a node.
  const narrationOk = narrationReferencesOnlyNodes(authored.narration, kept);

  return { nodes: kept, edges: keptEdges, narrationOk, dropped, unassignedFiles };
}

/** Tech proper nouns that look like component names but are brands/languages —
 *  exempt so narration like "written in TypeScript" doesn't trip the check. */
const BRAND_WORDS = new Set([
  'typescript', 'javascript', 'github', 'gitlab', 'openai', 'postgresql', 'postgres',
  'mongodb', 'graphql', 'nodejs', 'huggingface', 'pytorch', 'tensorflow', 'kubernetes',
  'dynamodb', 'redis', 'sqlite', 'webgl', 'webrtc',
]);

function narrationReferencesOnlyNodes(narration: string, nodes: AuthoredNode[]): boolean {
  return narrationMentionsOnly(narration, nodes.map(n => n.label));
}

/** A PascalCase identifier in `text` (FileLoader, GGUFWriter, HFStreamer) that
 *  doesn't match any of `nodeLabels` means the words and the picture disagree.
 *  The pattern matches both camel humps (FileLoader) and acronym-prefixed
 *  compounds (GGUFWriter, HFStreamer, HWScanner). Plain prose ("converge",
 *  "sources") and single Capitalized words never trip it. Reused to keep a
 *  spoken briefing coherent with the flow diagram it surfaces alongside. */
export function narrationMentionsOnly(text: string, nodeLabels: string[]): boolean {
  const labelTokens = nodeLabels.map(l => normalizeTokens(l));
  const mentions = text.match(/\b[A-Z][A-Za-z0-9]*[A-Z][a-z][A-Za-z0-9]*\b/g) ?? [];
  for (const m of mentions) {
    if (BRAND_WORDS.has(m.toLowerCase())) continue;
    const mt = normalizeTokens(m);
    if (mt.size === 0) continue;
    const covered = labelTokens.some(lt => overlaps(mt, lt));
    if (!covered) return false;
  }
  return true;
}

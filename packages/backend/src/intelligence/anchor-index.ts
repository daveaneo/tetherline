/**
 * Anchor index — the rich alias→node map behind two consumers:
 *   1. narration anchor-tagging (karaoke pulses): chunk text is matched
 *      against EVERY alias, so prose like "the FileLoader" or
 *      "file_loader.py" both light up the right node;
 *   2. the visual dispatcher's global node sets (resolve REFS lines and
 *      free-form targets to node ids anywhere in the diagram model).
 *
 * Built once per session after diagram warming; pure and cheap to rebuild.
 * Aliases are deliberately conservative: min length 3, an English stoplist,
 * and longest-first matching — a module named "core" should pulse on
 * "core", but a node must never match on words like "the" or "data".
 */
import type { DiagramRow } from '../db/repositories/diagram-cache-repo.js';

export interface AnchorEntry {
  nodeId: string;
  label: string;
  aliases: string[];
}

export interface AnchorIndex {
  entries: AnchorEntry[];
  /** Node ids whose aliases appear (word-boundary) in the text. */
  resolve(text: string): string[];
  /** Resolve one free-form name (a REFS item / spoken target) to a node id. */
  resolveName(name: string): string | null;
  allNodeIds(): string[];
  labels(): Record<string, string>;
  /** Flat alias list (legacy consumers: knownNodeLabels / batch chunker). */
  allAliases(): string[];
}

const STOPLIST = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'this', 'that', 'with', 'from',
  'into', 'data', 'code', 'file', 'files', 'main', 'index', 'test', 'tests',
  'src', 'lib', 'app', 'api', 'new', 'old', 'all', 'one', 'two', 'use', 'get',
  'set', 'run', 'type', 'types', 'util', 'utils', 'common', 'shared', 'base',
]);

function caseVariants(name: string): string[] {
  const out = new Set<string>([name]);
  // snake/kebab/camel cross-forms: file_loader ↔ file-loader ↔ fileLoader ↔ FileLoader
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_./-]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
  if (words.length > 1) {
    out.add(words.join('_'));
    out.add(words.join('-'));
    out.add(words[0] + words.slice(1).map(w => w[0].toUpperCase() + w.slice(1)).join(''));
  }
  return [...out];
}

function leafOf(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1];
}

export function buildAnchorIndex(opts: {
  diagramRows: DiagramRow[];
  modules: Array<{ modulePath: string }>;
  fileTree: string[];
  areas: Array<{ name: string }>;
}): AnchorIndex {
  const byNode = new Map<string, AnchorEntry>();

  const addAlias = (nodeId: string, label: string, raw: string) => {
    const alias = raw.trim();
    if (alias.length < 3) return;
    if (STOPLIST.has(alias.toLowerCase())) return;
    let entry = byNode.get(nodeId);
    if (!entry) {
      entry = { nodeId, label, aliases: [] };
      byNode.set(nodeId, entry);
    }
    if (!entry.aliases.some(a => a.toLowerCase() === alias.toLowerCase())) {
      entry.aliases.push(alias);
    }
  };

  for (const row of opts.diagramRows) {
    for (const node of row.nodes) {
      addAlias(node.id, node.label, node.label);
      for (const v of caseVariants(node.label)) addAlias(node.id, node.label, v);
      const leaf = leafOf(node.id);
      addAlias(node.id, node.label, leaf);
      // file-ish leaves also anchor without their extension
      const stem = leaf.replace(/\.[^.]+$/, '');
      if (stem !== leaf) addAlias(node.id, node.label, stem);
      for (const f of node.implementsFiles ?? []) {
        const base = f.split('/').pop() ?? '';
        addAlias(node.id, node.label, base);
        const fstem = base.replace(/\.[^.]+$/, '');
        if (fstem !== base) addAlias(node.id, node.label, fstem);
      }
    }
  }

  // Modules not present in any diagram row still anchor (module/<path>).
  for (const m of opts.modules) {
    const id = `module/${m.modulePath}`;
    if (![...byNode.keys()].some(k => k === id)) {
      addAlias(id, m.modulePath, m.modulePath);
      addAlias(id, m.modulePath, leafOf(m.modulePath));
    }
  }

  // Area names → the module node their name most resembles (exact-ish only;
  // fuzzy area mapping caused mis-pulses, so keep it to leaf inclusion).
  for (const a of opts.areas) {
    const an = a.name.toLowerCase();
    for (const [nodeId, entry] of byNode) {
      if (!nodeId.startsWith('module/')) continue;
      const leaf = leafOf(nodeId).toLowerCase();
      if (leaf.length >= 3 && an.includes(leaf)) {
        addAlias(nodeId, entry.label, a.name);
        break;
      }
    }
  }

  const entries = [...byNode.values()];
  // Longest-first global alias table for scanning.
  const flat: Array<{ alias: string; nodeId: string }> = entries
    .flatMap(e => e.aliases.map(alias => ({ alias, nodeId: e.nodeId })))
    .sort((a, b) => b.alias.length - a.alias.length);

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return {
    entries,
    resolve(text: string): string[] {
      const found = new Set<string>();
      for (const { alias, nodeId } of flat) {
        if (found.has(nodeId)) continue;
        const re = new RegExp(`(^|[^A-Za-z0-9_])${escape(alias)}([^A-Za-z0-9_]|$)`, 'i');
        if (re.test(text)) found.add(nodeId);
      }
      return [...found];
    },
    resolveName(name: string): string | null {
      const n = name.trim().toLowerCase();
      if (!n) return null;
      // exact id, then exact alias, then leaf
      if (byNode.has(name)) return name;
      for (const e of entries) {
        if (e.aliases.some(a => a.toLowerCase() === n)) return e.nodeId;
      }
      for (const e of entries) {
        if (leafOf(e.nodeId).toLowerCase() === n) return e.nodeId;
      }
      return null;
    },
    allNodeIds: () => entries.map(e => e.nodeId),
    labels: () => Object.fromEntries(entries.map(e => [e.nodeId, e.label])),
    allAliases: () => flat.map(f => f.alias),
  };
}

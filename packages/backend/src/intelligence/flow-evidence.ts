/** Gather the real evidence an authored flow diagram must be grounded in:
 *  the target module's files + the file-level import edges between them.
 *  Feeds flow-validate (node grounding + edge support) and the authoring
 *  prompt. Resolves Python dotted imports to file paths so edge support
 *  works on Python repos, not just JS (the import-parser caveat).
 */
import path from 'path';
import { parseImports } from '../cache/import-parser.js';
import type { FlowEvidence } from './flow-validate.js';

export interface FlowModule {
  modulePath: string;
  keyFiles: string[];
}
export interface FlowEvidenceDeps {
  repoPath: string;
  modules: FlowModule[];
}

function leafOf(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

/** Resolve a free-form target ("core", "the core module") to a module. */
function resolveModule(target: string, modules: FlowModule[]): FlowModule | null {
  const t = target.toLowerCase().replace(/\b(the|module|view|flow|workflow|pipeline)\b/g, '').trim();
  if (!t) return null;
  // 1. exact modulePath / leaf.
  for (const m of modules) {
    if (m.modulePath.toLowerCase() === t || leafOf(m.modulePath).toLowerCase() === t) return m;
  }
  // 2. substring on modulePath / leaf (longest match wins for determinism).
  const subs = modules
    .filter(m => m.modulePath.toLowerCase().includes(t) || leafOf(m.modulePath).toLowerCase().includes(t))
    .sort((a, b) => a.modulePath.length - b.modulePath.length);
  return subs[0] ?? null;
}

const norm = (f: string) => f.replace(/\.[^./]+$/, '');

/** Resolve one parsed import specifier to a file within `files`. Handles both
 *  JS resolved paths ("core/web_collector") and Python dotted names
 *  ("core.web_collector" / "personalforge.core.web_collector"). */
function resolveImportToFile(imp: string, files: string[]): string | null {
  const dotted = imp.replace(/\./g, '/');
  const lastSeg = imp.split(/[./]/).filter(Boolean).pop() ?? imp;
  for (const f of files) {
    const fn = norm(f);
    if (fn === imp || fn === dotted || fn.endsWith('/' + dotted)) return f;
  }
  for (const f of files) {
    if (norm(leafOf(f)) === lastSeg) return f;
  }
  return null;
}

/** File-level import edges between the module's own files (importer → imported). */
function moduleImportEdges(files: string[], repoPath: string): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const file of files) {
    const imports = parseImports(path.join(repoPath, file), repoPath);
    for (const imp of imports) {
      const target = resolveImportToFile(imp, files);
      if (!target || target === file) continue;
      const key = `${file}|${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: file, to: target });
    }
  }
  return edges;
}

export function buildFlowEvidence(target: string, deps: FlowEvidenceDeps): FlowEvidence | null {
  const mod = resolveModule(target, deps.modules);
  if (!mod) return null;
  const files = mod.keyFiles.slice(0, 40);
  return {
    moduleName: leafOf(mod.modulePath),
    files,
    importEdges: moduleImportEdges(files, deps.repoPath),
  };
}

import fs from 'fs';
import path from 'path';

export interface ImportEdge {
  from: string; // importing file
  to: string;   // imported file (resolved to relative path)
}

export function parseImports(filePath: string, repoPath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      return parseJsImports(content, filePath, repoPath);
    }
    if (ext === '.py') {
      return parsePythonImports(content);
    }
    if (ext === '.go') {
      return parseGoImports(content);
    }
    if (ext === '.rs') {
      return parseRustImports(content);
    }
    return [];
  } catch {
    return [];
  }
}

function parseJsImports(content: string, filePath: string, repoPath: string): string[] {
  const imports: string[] = [];
  // import ... from '...'
  const importRegex = /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g;
  // require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const resolved = resolveJsImport(match[1], filePath, repoPath);
    if (resolved) imports.push(resolved);
  }
  while ((match = requireRegex.exec(content)) !== null) {
    const resolved = resolveJsImport(match[1], filePath, repoPath);
    if (resolved) imports.push(resolved);
  }
  return imports;
}

function resolveJsImport(specifier: string, fromFile: string, repoPath: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null; // skip node_modules
  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, specifier);
  const relative = path.relative(repoPath, resolved).replace(/\\/g, '/');
  // Strip extension variations
  return relative.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, '').replace(/\/index$/, '');
}

function parsePythonImports(content: string): string[] {
  const imports: string[] = [];
  const fromRegex = /^from\s+(\S+)\s+import/gm;
  const importRegex = /^import\s+(\S+)/gm;
  let match: RegExpExecArray | null;
  while ((match = fromRegex.exec(content)) !== null) imports.push(match[1]);
  while ((match = importRegex.exec(content)) !== null) imports.push(match[1]);
  return imports;
}

function parseGoImports(content: string): string[] {
  const imports: string[] = [];
  const blockMatch = content.match(/import\s*\(([\s\S]*?)\)/);
  if (blockMatch) {
    const lines = blockMatch[1].split('\n');
    for (const line of lines) {
      const m = line.match(/["']([^"']+)["']/);
      if (m) imports.push(m[1]);
    }
  }
  const singleRegex = /import\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = singleRegex.exec(content)) !== null) imports.push(match[1]);
  return imports;
}

function parseRustImports(content: string): string[] {
  const imports: string[] = [];
  const useRegex = /use\s+([\w:]+)/g;
  let match: RegExpExecArray | null;
  while ((match = useRegex.exec(content)) !== null) imports.push(match[1]);
  return imports;
}

/** Build connectivity map: file -> number of files that import it */
export function buildConnectivityMap(files: string[], repoPath: string): Map<string, number> {
  const importCount = new Map<string, number>();
  for (const [, targets] of buildImportEdges(files, repoPath)) {
    for (const target of targets) {
      importCount.set(target, (importCount.get(target) ?? 0) + 1);
    }
  }
  return importCount;
}

/** Per-file import edges: source file → set of repo-relative target
 *  files it imports from. Used by the warmer to aggregate cross-module
 *  dependencies for the radial map's "Module connections" section in
 *  the Q&A scaffold. */
export function buildImportEdges(files: string[], repoPath: string): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  // Only parse a subset for performance (top files by size/importance).
  const filesToParse = files.slice(0, 300);
  for (const file of filesToParse) {
    const fullPath = path.join(repoPath, file);
    const imports = parseImports(fullPath, repoPath);
    if (imports.length === 0) continue;
    const targets = new Set<string>();
    for (const imp of imports) {
      const match = files.find(f => f.replace(/\.[^.]+$/, '') === imp || f === imp);
      if (match && match !== file) targets.add(match);
    }
    if (targets.size > 0) edges.set(file, targets);
  }
  return edges;
}

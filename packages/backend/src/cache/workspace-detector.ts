/**
 * Workspace detector — finds pnpm / npm / yarn / lerna workspace
 * packages so the cache warmer can split a monorepo into its
 * actual member modules instead of collapsing everything under
 * `packages/`.
 *
 * Output: a list of detected workspaces with their directory path
 * (relative to the repo root) and a display name (taken from the
 * workspace's own package.json `name`, falling back to dir basename).
 */
import fs from 'fs';
import path from 'path';

export interface DetectedWorkspace {
  /** Directory path relative to repo root (forward slashes). e.g. "packages/backend". */
  pathPrefix: string;
  /** Short display name. e.g. "backend" — used for module IDs. */
  name: string;
  /** Full package name from the workspace's package.json, if any. */
  fullName?: string;
}

export function detectWorkspaces(repoPath: string): DetectedWorkspace[] {
  // pnpm-workspace.yaml gets first priority — that's the de facto
  // standard for this codebase and most modern monorepos.
  const patterns = readPnpmWorkspaces(repoPath)
    ?? readPackageJsonWorkspaces(repoPath)
    ?? readLernaWorkspaces(repoPath)
    ?? [];

  if (patterns.length === 0) return [];

  const workspaces: DetectedWorkspace[] = [];
  for (const pattern of patterns) {
    for (const dir of expandWorkspacePattern(repoPath, pattern)) {
      const ws = describeWorkspace(repoPath, dir);
      if (ws) workspaces.push(ws);
    }
  }
  // Dedupe by pathPrefix; first-wins.
  const seen = new Set<string>();
  return workspaces.filter(w => {
    if (seen.has(w.pathPrefix)) return false;
    seen.add(w.pathPrefix);
    return true;
  });
}

function readPnpmWorkspaces(repoPath: string): string[] | null {
  const file = path.join(repoPath, 'pnpm-workspace.yaml');
  if (!fs.existsSync(file)) return null;
  try {
    const content = fs.readFileSync(file, 'utf-8');
    // Minimal YAML parse — we only need the `packages:` array. Avoid
    // bringing in a full YAML lib for this single file format.
    const lines = content.split('\n');
    const out: string[] = [];
    let inPackages = false;
    for (const line of lines) {
      if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
      if (inPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*$/);
        if (m) { out.push(m[1]); continue; }
        // Stop on next top-level key.
        if (/^\S/.test(line)) inPackages = false;
      }
    }
    return out.length > 0 ? out : null;
  } catch { return null; }
}

function readPackageJsonWorkspaces(repoPath: string): string[] | null {
  const file = path.join(repoPath, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // Accept both the array form (npm / yarn classic) and the object
    // form (yarn berry: `{ packages: [...] }`).
    if (Array.isArray(pkg.workspaces)) return pkg.workspaces as string[];
    if (Array.isArray(pkg.workspaces?.packages)) return pkg.workspaces.packages as string[];
    return null;
  } catch { return null; }
}

function readLernaWorkspaces(repoPath: string): string[] | null {
  const file = path.join(repoPath, 'lerna.json');
  if (!fs.existsSync(file)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(cfg.packages)) return cfg.packages as string[];
    return null;
  } catch { return null; }
}

/** Resolve a glob like "packages/*" to a list of actual directories.
 *  We only support the trailing-`*` and trailing-`**` patterns that are
 *  ubiquitous in real monorepos — full glob support isn't needed. */
function expandWorkspacePattern(repoPath: string, pattern: string): string[] {
  // Strip leading "./", normalize separators.
  const normalized = pattern.replace(/^\.\//, '').replace(/\\/g, '/');

  if (!normalized.includes('*')) {
    // Direct path, e.g. "tools/build". Verify it exists.
    const full = path.join(repoPath, normalized);
    return fs.existsSync(full) && fs.statSync(full).isDirectory() ? [normalized] : [];
  }

  // Pattern like "packages/*" or "packages/**". Treat as "every direct
  // child directory of the prefix that contains a package.json".
  const prefix = normalized.replace(/\/\*+$/, '');
  const parent = path.join(repoPath, prefix);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return [];

  return fs.readdirSync(parent, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => `${prefix}/${e.name}`)
    .filter(rel => fs.existsSync(path.join(repoPath, rel, 'package.json')));
}

function describeWorkspace(repoPath: string, relDir: string): DetectedWorkspace | null {
  const dirAbs = path.join(repoPath, relDir);
  if (!fs.existsSync(dirAbs)) return null;
  const pkgFile = path.join(dirAbs, 'package.json');
  let fullName: string | undefined;
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
      if (typeof pkg.name === 'string') fullName = pkg.name;
    } catch { /* ignore */ }
  }
  // Display name: dir basename. Strip "@scope/" if we go from full name.
  const base = path.basename(relDir);
  const name = fullName ? fullName.replace(/^@[^/]+\//, '') : base;
  return { pathPrefix: relDir, name, fullName };
}

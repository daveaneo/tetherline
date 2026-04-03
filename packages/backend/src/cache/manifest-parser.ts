import fs from 'fs';
import path from 'path';

export interface ManifestData {
  exists: boolean;
  name: string;
  description: string;
  techStack: string[]; // from dependencies
  scripts: string[];   // available scripts/commands
  type: 'node' | 'python' | 'rust' | 'go' | 'unknown';
}

export function parseManifest(repoPath: string): ManifestData {
  // Try each manifest type in order of prevalence
  return parsePackageJson(repoPath)
    ?? parsePyproject(repoPath)
    ?? parseCargoToml(repoPath)
    ?? parseGoMod(repoPath)
    ?? { exists: false, name: '', description: '', techStack: [], scripts: [], type: 'unknown' };
}

function parsePackageJson(repoPath: string): ManifestData | null {
  const filePath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    const techStack = [...deps.slice(0, 15), ...devDeps.filter(d =>
      /typescript|vite|webpack|jest|vitest|eslint|prettier/i.test(d)
    ).slice(0, 5)];

    return {
      exists: true,
      name: pkg.name ?? '',
      description: pkg.description ?? '',
      techStack,
      scripts: Object.keys(pkg.scripts ?? {}),
      type: 'node',
    };
  } catch { return null; }
}

function parsePyproject(repoPath: string): ManifestData | null {
  // Check for pyproject.toml or requirements.txt
  const pyproject = path.join(repoPath, 'pyproject.toml');
  const requirements = path.join(repoPath, 'requirements.txt');

  if (fs.existsSync(pyproject)) {
    try {
      const content = fs.readFileSync(pyproject, 'utf-8');
      const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
      const descMatch = content.match(/description\s*=\s*"([^"]+)"/);
      const depsMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      const deps = depsMatch ? depsMatch[1].match(/"([^"]+)"/g)?.map(d => d.replace(/"/g, '').split(/[>=<]/)[0]) ?? [] : [];

      return {
        exists: true,
        name: nameMatch?.[1] ?? '',
        description: descMatch?.[1] ?? '',
        techStack: deps.slice(0, 15),
        scripts: [],
        type: 'python',
      };
    } catch { /* fall through */ }
  }

  if (fs.existsSync(requirements)) {
    try {
      const content = fs.readFileSync(requirements, 'utf-8');
      const deps = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split(/[>=<]/)[0].trim());
      return {
        exists: true, name: '', description: '', techStack: deps.slice(0, 15), scripts: [], type: 'python',
      };
    } catch { /* fall through */ }
  }

  return null;
}

function parseCargoToml(repoPath: string): ManifestData | null {
  const filePath = path.join(repoPath, 'Cargo.toml');
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
    const descMatch = content.match(/description\s*=\s*"([^"]+)"/);
    return {
      exists: true, name: nameMatch?.[1] ?? '', description: descMatch?.[1] ?? '',
      techStack: ['Rust'], scripts: [], type: 'rust',
    };
  } catch { return null; }
}

function parseGoMod(repoPath: string): ManifestData | null {
  const filePath = path.join(repoPath, 'go.mod');
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const moduleMatch = content.match(/module\s+(\S+)/);
    const deps = content.match(/require\s*\(([\s\S]*?)\)/)?.[1]
      ?.split('\n').filter(l => l.trim()).map(l => l.trim().split(/\s/)[0]) ?? [];
    return {
      exists: true, name: moduleMatch?.[1] ?? '', description: '',
      techStack: ['Go', ...deps.slice(0, 10)], scripts: [], type: 'go',
    };
  } catch { return null; }
}

import simpleGit from 'simple-git';
import path from 'path';
import { hashFile } from './hash-utils.js';
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';

export interface CacheDiffReport {
  changedFiles: string[];
  newFiles: string[];
  deletedFiles: string[];
  staleModules: string[];
  projectStale: boolean;
  unchangedCount: number;
}

export async function detectChanges(
  repoPath: string,
  repo: ContextCacheRepository,
): Promise<CacheDiffReport> {
  const git = simpleGit(repoPath);

  // Get the cached HEAD hash
  const projectCache = repo.getProject(repoPath);
  const cachedHead = projectCache?.triggerHashes?.head;

  let changedFilePaths: string[] | null = null;

  // Fast path: use git diff if we have a cached HEAD
  if (cachedHead) {
    try {
      const diffOutput = await git.diff(['--name-only', cachedHead, 'HEAD']);
      changedFilePaths = diffOutput.split('\n').filter(Boolean);
    } catch {
      // cached HEAD is unreachable (rebased, force-pushed), fall back to full scan
    }
  }

  // Get all tracked files
  const allFilesRaw = await git.raw(['ls-files']).catch(() => '');
  const allFiles = allFilesRaw.split('\n').filter(Boolean);

  // Get cached files
  const cachedFiles = repo.getFilesForRepo(repoPath);
  const cachedFileMap = new Map(cachedFiles.map(f => [f.filePath, f]));

  const changedFiles: string[] = [];
  const newFiles: string[] = [];

  if (changedFilePaths !== null) {
    // Fast path: only check files git says changed
    for (const filePath of changedFilePaths) {
      if (cachedFileMap.has(filePath)) {
        changedFiles.push(filePath);
      } else {
        newFiles.push(filePath);
      }
    }
  } else {
    // Slow path: hash every file and compare
    for (const filePath of allFiles) {
      const cached = cachedFileMap.get(filePath);
      if (!cached) {
        newFiles.push(filePath);
      } else {
        const currentHash = hashFile(path.join(repoPath, filePath));
        if (currentHash !== cached.contentHash) {
          changedFiles.push(filePath);
        }
      }
    }
  }

  // Deleted files: in cache but not on disk
  const allFileSet = new Set(allFiles);
  const deletedFiles = cachedFiles
    .filter(f => !allFileSet.has(f.filePath))
    .map(f => f.filePath);

  // Find stale modules: modules containing any changed/new/deleted file
  const allChanged = new Set([...changedFiles, ...newFiles, ...deletedFiles]);
  const staleModules = new Set<string>();
  for (const file of allChanged) {
    const module = file.split('/')[0];
    staleModules.add(module);
  }

  // Project is stale if README or manifest changed
  const projectStale = changedFiles.some(f =>
    /^readme/i.test(f) || f === 'package.json' || f === 'pyproject.toml' ||
    f === 'Cargo.toml' || f === 'go.mod'
  ) || staleModules.size > (allFiles.length > 0 ? allFiles.length * 0.3 : 0);

  return {
    changedFiles,
    newFiles,
    deletedFiles,
    staleModules: [...staleModules],
    projectStale,
    unchangedCount: allFiles.length - changedFiles.length - newFiles.length,
  };
}

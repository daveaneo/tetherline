import path from 'path';
import simpleGit from 'simple-git';
import { parseReadme, parseModuleReadme } from './readme-parser.js';
import { parseManifest } from './manifest-parser.js';
import { buildConnectivityMap } from './import-parser.js';
import { hashFile, hashString } from './hash-utils.js';
import { detectChanges } from './diff-detector.js';
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';
import type { IClaudeClient } from '../intelligence/client-interface.js';
import {
  buildModuleSummaryPrompt,
  buildProjectSynthesisPrompt,
} from '../intelligence/prompts/context-cache.js';

export class ContextCacheWarmer {
  constructor(
    private repo: ContextCacheRepository,
    private client: IClaudeClient | null,
    private onProgress?: (msg: string) => void,
  ) {}

  async warm(repoPath: string): Promise<void> {
    const existingProject = this.repo.getProject(repoPath);

    if (existingProject) {
      // Warm start: check what changed
      const diff = await detectChanges(repoPath, this.repo);

      if (diff.changedFiles.length === 0 && diff.newFiles.length === 0 && diff.deletedFiles.length === 0) {
        this.onProgress?.('Cache is fresh — no changes detected');
        return;
      }

      this.onProgress?.(`${diff.changedFiles.length + diff.newFiles.length} files changed`);

      // Update hashes for changed files
      for (const filePath of [...diff.changedFiles, ...diff.newFiles]) {
        const fullPath = path.join(repoPath, filePath);
        const hash = hashFile(fullPath);
        const existing = this.repo.getFile(repoPath, filePath);
        if (existing) {
          this.repo.upsertFile({ ...existing, contentHash: hash, confidence: existing.confidence * 0.5 });
        } else {
          this.repo.upsertFile({
            repoPath, filePath, summary: '', contentHash: hash,
            connectivity: 0, role: 'other', confidence: 0,
          });
        }
      }

      // Delete removed files
      for (const filePath of diff.deletedFiles) {
        this.repo.deleteFile(repoPath, filePath);
      }

      // Decay confidence on stale modules
      for (const mod of diff.staleModules) {
        this.repo.decayConfidence(repoPath, mod, 0.5);
      }

      // Update HEAD hash
      const git = simpleGit(repoPath);
      const head = (await git.revparse(['HEAD']).catch(() => '')).trim();
      if (existingProject) {
        existingProject.triggerHashes.head = head;
        this.repo.upsertProject(existingProject);
      }

      return; // Warm start done. No LLM calls. Lazy re-summarization on visit.
    }

    // Cold start: build from scratch
    await this.coldStart(repoPath);
  }

  private async coldStart(repoPath: string): Promise<void> {
    this.onProgress?.('Building project knowledge...');
    const repoName = path.basename(repoPath);

    // Phase 1: Free intelligence
    this.onProgress?.('Reading README and manifest...');
    const readme = parseReadme(repoPath);
    const manifest = parseManifest(repoPath);

    const git = simpleGit(repoPath);
    const allFilesRaw = await git.raw(['ls-files']).catch(() => '');
    const allFiles = allFilesRaw.split('\n').filter(Boolean);
    const head = (await git.revparse(['HEAD']).catch(() => '')).trim();

    this.onProgress?.('Analyzing imports and structure...');
    const connectivity = buildConnectivityMap(allFiles, repoPath);

    // Hash all files
    for (const filePath of allFiles) {
      const fullPath = path.join(repoPath, filePath);
      const hash = hashFile(fullPath);
      const conn = connectivity.get(filePath) ?? 0;
      const role = guessFileRole(filePath);

      this.repo.upsertFile({
        repoPath, filePath, summary: '', contentHash: hash,
        connectivity: conn, role, confidence: 0,
      });
    }

    // Detect modules from directory structure + README mentions
    const topDirs = [...new Set(allFiles.map(f => f.split('/')[0]).filter(d => !d.includes('.')))];
    const moduleMap: Record<string, string[]> = {};
    const moduleSummaries: Array<{ name: string; summary: string; source: 'readme' | 'llm' | 'heuristic' }> = [];

    // Try README-based module detection first
    for (const dir of topDirs) {
      const readmeMention = readme.moduleMentions.get(dir);
      const moduleReadme = parseModuleReadme(path.join(repoPath, dir));
      const summary = readmeMention ?? moduleReadme?.purpose ?? '';
      const filesInModule = allFiles.filter(f => f.startsWith(dir + '/'));
      moduleMap[dir] = filesInModule;

      if (summary) {
        moduleSummaries.push({ name: dir, summary, source: 'readme' });
        this.repo.upsertModule({
          repoPath, modulePath: dir, summary, source: 'readme',
          keyFiles: filesInModule.sort((a, b) => (connectivity.get(b) ?? 0) - (connectivity.get(a) ?? 0)).slice(0, 5),
          imports: [], confidence: 0.8,
        });
      } else {
        // No README for this module — needs LLM
        moduleSummaries.push({ name: dir, summary: `Contains ${filesInModule.length} files`, source: 'heuristic' });
        this.repo.upsertModule({
          repoPath, modulePath: dir, summary: `Contains ${filesInModule.length} files`,
          source: 'heuristic', keyFiles: filesInModule.slice(0, 5), imports: [], confidence: 0.2,
        });
      }
    }

    // Phase 2: LLM fills gaps (if client available)
    if (this.client) {
      // Summarize modules without README coverage
      const gapModules = moduleSummaries.filter(m => m.source === 'heuristic' && (moduleMap[m.name]?.length ?? 0) > 2);

      if (gapModules.length > 0) {
        this.onProgress?.(`AI analyzing ${gapModules.length} modules...`);
        for (const mod of gapModules.slice(0, 10)) {
          try {
            const filesInMod = (moduleMap[mod.name] ?? []).slice(0, 20);
            const fileSummaries = filesInMod.map(f => `- ${f} (${guessFileRole(f)})`);
            const readmeContent = readme.moduleMentions.get(mod.name);

            const prompt = buildModuleSummaryPrompt(mod.name, fileSummaries, readmeContent);
            const summary = await this.client.streamText({
              system: `You are analyzing the codebase "${repoName}". Summarize this module concisely.`,
              messages: [{ role: 'user', content: prompt }],
              maxTokens: 200,
            });

            this.repo.upsertModule({
              repoPath, modulePath: mod.name, summary: summary.trim(),
              source: 'llm', keyFiles: filesInMod.sort((a, b) => (connectivity.get(b) ?? 0) - (connectivity.get(a) ?? 0)).slice(0, 5),
              imports: [], confidence: 0.9,
            });
            mod.summary = summary.trim();
            mod.source = 'llm';
          } catch { /* keep heuristic summary */ }
        }
      }

      // Project synthesis
      this.onProgress?.('Synthesizing project overview...');
      try {
        const modSummaryTexts = moduleSummaries.map(m => `${m.name}: ${m.summary}`);
        const prompt = buildProjectSynthesisPrompt(
          repoName, readme.purpose, manifest.description, manifest.techStack, modSummaryTexts,
        );
        const projectSummary = await this.client.streamText({
          system: 'Synthesize a concise project summary. One paragraph. Spoken aloud via TTS.',
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 300,
        });

        this.repo.upsertProject({
          repoPath, summary: projectSummary.trim(), purpose: readme.purpose || manifest.description,
          techStack: manifest.techStack, moduleMap,
          triggerHashes: {
            head,
            readme: readme.exists ? hashString(readme.raw) : '',
            manifest: manifest.exists ? hashString(JSON.stringify(manifest)) : '',
          },
          confidence: 0.9,
        });
      } catch {
        // Fallback: use README purpose directly
        this.repo.upsertProject({
          repoPath, summary: readme.purpose || manifest.description || `${repoName} project`,
          purpose: readme.purpose || manifest.description, techStack: manifest.techStack,
          moduleMap, triggerHashes: { head }, confidence: 0.4,
        });
      }
    } else {
      // No LLM: store what we have from READMEs and manifests
      this.repo.upsertProject({
        repoPath, summary: readme.purpose || manifest.description || `${repoName} project`,
        purpose: readme.purpose || manifest.description, techStack: manifest.techStack,
        moduleMap, triggerHashes: { head }, confidence: 0.4,
      });
    }

    this.onProgress?.('Project knowledge built');
  }
}

function guessFileRole(filePath: string): string {
  const name = path.basename(filePath).toLowerCase();
  const dir = filePath.toLowerCase();
  if (/test|spec|__test__|__spec__/.test(dir)) return 'test';
  if (/config|\.config\.|\.env|settings/.test(name)) return 'config';
  if (/type[sd]?\./.test(name) || /\.d\.ts$/.test(name)) return 'type';
  if (/index\.|main\.|app\.|server\./.test(name)) return 'entry';
  if (/model|schema|entity|migration/.test(name)) return 'model';
  if (/route|controller|handler|endpoint/.test(name)) return 'route';
  if (/component|widget|view|page/.test(dir)) return 'component';
  if (/util|helper|lib/.test(dir)) return 'utility';
  return 'other';
}

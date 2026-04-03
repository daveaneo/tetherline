import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';

export interface ContextQuery {
  type: 'file_focus' | 'module_focus' | 'architecture' | 'question';
  filePath?: string;
  modulePath?: string;
  question?: string;
  tokenBudget?: number;
}

export class ContextComposer {
  constructor(
    private repo: ContextCacheRepository,
    private repoPath: string,
  ) {}

  compose(query: ContextQuery): string {
    const budget = query.tokenBudget ?? 2000;
    const sections: string[] = [];
    let tokensUsed = 0;

    // Always include project summary
    const project = this.repo.getProject(this.repoPath);
    if (project?.summary) {
      const section = `## Project: ${project.purpose || this.repoPath}\n${project.summary}`;
      sections.push(section);
      tokensUsed += estimateTokens(section);
    }

    if (query.type === 'architecture') {
      // All module summaries
      const modules = this.repo.getModulesForRepo(this.repoPath);
      for (const mod of modules) {
        if (tokensUsed > budget * 0.9) break;
        if (mod.confidence < 0.3) continue;
        const section = `### ${mod.modulePath}\n${mod.summary}`;
        sections.push(section);
        tokensUsed += estimateTokens(section);
      }
    }

    if (query.type === 'module_focus' && query.modulePath) {
      const mod = this.repo.getModule(this.repoPath, query.modulePath);
      if (mod?.summary) {
        sections.push(`### Module: ${mod.modulePath}\n${mod.summary}\nKey files: ${mod.keyFiles.join(', ')}`);
      }
      // Add file summaries for this module
      const files = this.repo.getFilesForRepo(this.repoPath)
        .filter(f => f.filePath.startsWith(query.modulePath + '/') && f.confidence > 0.3);
      for (const file of files.slice(0, 20)) {
        if (tokensUsed > budget * 0.9) break;
        const line = `- ${file.filePath}: ${file.summary || file.role}`;
        sections.push(line);
        tokensUsed += estimateTokens(line);
      }
    }

    if (query.type === 'file_focus' && query.filePath) {
      // Find the module this file belongs to
      const modulePath = query.filePath.split('/')[0];
      const mod = this.repo.getModule(this.repoPath, modulePath);
      if (mod?.summary) {
        sections.push(`### Module: ${mod.modulePath}\n${mod.summary}`);
      }
      const file = this.repo.getFile(this.repoPath, query.filePath);
      if (file?.summary) {
        sections.push(`### File: ${file.filePath}\n${file.summary}`);
      }
    }

    if (query.type === 'question' && query.question) {
      // Relevance matching: find modules/files whose summaries match the question
      const keywords = extractKeywords(query.question);
      const modules = this.repo.getModulesForRepo(this.repoPath);
      const scored = modules.map(m => ({
        mod: m,
        score: keywords.reduce((s, k) => s + (m.summary.toLowerCase().includes(k) ? 1 : 0) + (m.modulePath.toLowerCase().includes(k) ? 2 : 0), 0),
      })).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

      for (const { mod } of scored.slice(0, 3)) {
        if (tokensUsed > budget * 0.8) break;
        const section = `### ${mod.modulePath}\n${mod.summary}`;
        sections.push(section);
        tokensUsed += estimateTokens(section);
      }

      // Check Q&A cache
      const qas = this.repo.getQA(this.repoPath, keywords[0] ?? '');
      for (const qa of qas.slice(0, 2)) {
        if (tokensUsed > budget * 0.9) break;
        const section = `Previous Q&A:\nQ: ${qa.question}\nA: ${qa.answer}`;
        sections.push(section);
        tokensUsed += estimateTokens(section);
      }
    }

    return sections.join('\n\n');
  }

  /** Get a compact project summary for the system prompt */
  getProjectContext(): string {
    return this.compose({ type: 'architecture', tokenBudget: 1500 });
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'does', 'do', 'this', 'that', 'it', 'in', 'on', 'for', 'to', 'of', 'and', 'or']);
  return text.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));
}

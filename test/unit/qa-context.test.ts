import { describe, it, expect } from 'vitest';
import { buildQAContext } from '../../packages/backend/src/intelligence/qa-context.js';
import type { ContextCacheRepository } from '../../packages/backend/src/db/repositories/context-cache-repo.js';

function fakeCacheRepo(state: {
  project?: any;
  modules?: Array<{ modulePath: string; summary: string; confidence?: number }>;
}): ContextCacheRepository {
  const modules = (state.modules ?? []).map(m => ({
    repoPath: '/tmp/fixture',
    modulePath: m.modulePath,
    summary: m.summary,
    source: 'llm' as const,
    keyFiles: [],
    dependencies: [],
    confidence: m.confidence ?? 0.9,
    generatedAt: new Date().toISOString(),
  }));
  return {
    getProject: () => state.project ?? null,
    getModulesForRepo: () => modules,
    getModule: (_r: string, p: string) => modules.find(m => m.modulePath === p) ?? null,
    getFilesForRepo: () => [],
    getFile: () => null,
    getQA: () => [],
    upsertProject: () => {},
    upsertModule: () => {},
    upsertFile: () => {},
  } as unknown as ContextCacheRepository;
}

const repoPath = '/tmp/fixture';

describe('buildQAContext', () => {
  it('grounds the prompt with project name and summary so the LLM knows what "the project" means', () => {
    const repo = fakeCacheRepo({
      project: {
        repoPath,
        summary: 'Tetherline is a local-first AI code review tool.',
        purpose: 'Stay tethered to your codebase',
        techStack: ['TypeScript', 'React', 'Node'],
        moduleMap: {}, triggerHashes: {}, confidence: 0.9,
      },
    });
    const prompt = buildQAContext(repo, repoPath);
    expect(prompt).toMatch(/Tetherline/);
    expect(prompt).toMatch(/local-first AI code review tool/);
    expect(prompt).toMatch(/Stay tethered to your codebase/);
    expect(prompt).toMatch(/TypeScript/);
    expect(prompt).toMatch(/spoken aloud/);
    // Hermes persona is grounded in the prompt so the AI has an identity.
    expect(prompt).toMatch(/Hermes/);
  });

  it('emits the module map so the LLM can answer "what are the main parts?" without exploration', () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'A tool.', purpose: 'helps', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules: [
        { modulePath: 'auth', summary: 'Token issuance and rotation. Stores keys in keyring.' },
        { modulePath: 'payments', summary: 'Idempotent capture for money movement.' },
      ],
    });
    const prompt = buildQAContext(repo, repoPath);
    expect(prompt).toMatch(/`auth`/);
    expect(prompt).toMatch(/`payments`/);
    expect(prompt).toMatch(/Token issuance/);
    expect(prompt).toMatch(/Idempotent capture/);
  });

  it('opts in agentic exploration only when asked, and points the agent at the repo path', () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'X.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
    });
    const noTools = buildQAContext(repo, repoPath, { agenticTools: false });
    const withTools = buildQAContext(repo, repoPath, { agenticTools: true });
    expect(noTools).not.toMatch(/read access to the repo/);
    expect(withTools).toMatch(/read access to the repo/);
    expect(withTools).toMatch(repoPath);
  });

  it('threads recent turns so follow-ups stay coherent', () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'A tool.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
    });
    const prompt = buildQAContext(repo, repoPath, {
      recentTurns: [
        { role: 'user', content: 'What is the auth module?' },
        { role: 'assistant', content: 'Auth handles token issuance.' },
        { role: 'user', content: 'Where does it store keys?' },
      ],
    });
    expect(prompt).toMatch(/What is the auth module/);
    expect(prompt).toMatch(/token issuance/);
    expect(prompt).toMatch(/Where does it store keys/);
  });

  it('falls back to repo basename when project cache is empty (no "what project?" responses)', () => {
    const repo = fakeCacheRepo({});
    const prompt = buildQAContext(repo, '/home/dev/myproject');
    // Even with no cached summary, the LLM gets the basename so it can ground itself.
    expect(prompt).toMatch(/myproject/);
    expect(prompt).toMatch(/spoken aloud/);
  });

  it('caps module list to keep prompt size bounded', () => {
    const modules = Array.from({ length: 30 }, (_, i) => ({
      modulePath: `module-${i}`,
      summary: `Summary for module ${i}.`,
    }));
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'X.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules,
    });
    const prompt = buildQAContext(repo, repoPath, { maxModules: 5 });
    const moduleMatches = prompt.match(/^- `module-/gm) || [];
    expect(moduleMatches.length).toBe(5);
  });
});

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
    imports: [] as string[],
    confidence: m.confidence ?? 0.9,
    impactScore: 0,
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

  it('emits module-to-module dependency edges so connection questions can be answered structurally', () => {
    // module/auth imports from module/utils; module/payments imports auth.
    // The QA scaffold should surface these edges so "how does payments
    // connect to auth" or "if I add rate limiting, where?" answers are
    // grounded in the actual import graph, not guessed.
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'X.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules: [
        { modulePath: 'auth',     summary: 'Token issuance.' },
        { modulePath: 'utils',    summary: 'Helpers.' },
        { modulePath: 'payments', summary: 'Money movement.' },
      ],
    });
    // Patch in import edges (the fake cache repo doesn't simulate them
    // by default — drive directly on the underlying module list).
    const modules = repo.getModulesForRepo(repoPath);
    (modules.find(m => m.modulePath === 'auth') as any).imports = ['utils'];
    (modules.find(m => m.modulePath === 'payments') as any).imports = ['auth', 'utils'];
    const prompt = buildQAContext(repo, repoPath);

    expect(prompt).toMatch(/Module connections/);
    expect(prompt).toMatch(/`auth`\s+imports from\s+`utils`/);
    expect(prompt).toMatch(/`payments`\s+imports from\s+`auth`/);
  });

  it('orders modules in the scaffold by impactScore (gravity) when present', () => {
    const repo = fakeCacheRepo({
      project: { repoPath, summary: 'X.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
      modules: [
        { modulePath: 'aardvark', summary: 'Quiet.' },
        { modulePath: 'busy',     summary: 'Hot.' },
      ],
    });
    const modules = repo.getModulesForRepo(repoPath);
    (modules.find(m => m.modulePath === 'aardvark') as any).impactScore = 5;
    (modules.find(m => m.modulePath === 'busy') as any).impactScore = 200;
    const prompt = buildQAContext(repo, repoPath);

    const busyIdx = prompt.indexOf('`busy`');
    const aardvarkIdx = prompt.indexOf('`aardvark`');
    expect(busyIdx).toBeGreaterThan(0);
    expect(aardvarkIdx).toBeGreaterThan(0);
    // High-impact `busy` must appear before `aardvark` in the scaffold.
    expect(busyIdx).toBeLessThan(aardvarkIdx);
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

import { describe, it, expect } from 'vitest';
import { BriefingComposer } from '../../packages/backend/src/briefing/composer.js';
import type { ContextCacheRepository } from '../../packages/backend/src/db/repositories/context-cache-repo.js';

/** Minimal stand-in for ContextCacheRepository — only the methods the composer
 *  actually calls. Avoids pulling better-sqlite3 into the unit test. */
function makeFakeCacheRepo(state: {
  project?: any;
  modules?: Array<{ modulePath: string; summary: string; keyFiles?: string[]; confidence?: number }>;
  files?: Array<{ filePath: string; summary: string }>;
}): ContextCacheRepository {
  const modules = (state.modules ?? []).map(m => ({
    repoPath: '/tmp/fixture',
    modulePath: m.modulePath,
    summary: m.summary,
    source: 'llm' as const,
    keyFiles: m.keyFiles ?? [],
    dependencies: [],
    confidence: m.confidence ?? 0.9,
    generatedAt: new Date().toISOString(),
  }));
  return {
    getProject: () => state.project ?? null,
    getModulesForRepo: () => modules,
    getModule: (_r: string, p: string) => modules.find(m => m.modulePath === p) ?? null,
    getFilesForRepo: () => state.files ?? [],
    getFile: () => null,
    getQA: () => [],
    upsertProject: () => {},
    upsertModule: () => {},
    upsertFile: () => {},
  } as unknown as ContextCacheRepository;
}

describe('BriefingComposer', () => {
  const repoPath = '/tmp/fixture';

  it('composes a project briefing with a TTS-safe opener', () => {
    const repo = makeFakeCacheRepo({
      project: {
        repoPath,
        summary: 'Tetherline is a local-first developer tool that keeps you tethered to a codebase moving faster than you can absorb. It analyses a git repo, builds a project briefing, and walks you through what changed.',
        purpose: 'a voice-led weekly code review assistant',
        techStack: ['TypeScript', 'React'],
        moduleMap: {},
        triggerHashes: { head: 'abc123', readme: 'r1', manifest: 'm1' },
        confidence: 0.9,
      },
    });
    const composer = new BriefingComposer(repo, repoPath);
    const briefing = composer.composeProject();

    expect(briefing).not.toBeNull();
    expect(briefing!.id).toBe('project');
    expect(briefing!.layer).toBe('project');
    expect(briefing!.opener).toMatch(/Tetherline/);
    expect(briefing!.opener).not.toMatch(/^#/m);
    expect(briefing!.opener).not.toMatch(/```/);
    expect(briefing!.opener).not.toMatch(/^-\s/m);
    expect(briefing!.parent).toBeNull();
    expect(briefing!.estimatedSeconds).toBeGreaterThan(0);
    expect(briefing!.estimatedSeconds).toBeLessThanOrEqual(45);
  });

  it('returns null when project cache is absent', () => {
    const repo = makeFakeCacheRepo({});
    expect(new BriefingComposer(repo, repoPath).composeProject()).toBeNull();
  });

  it('composes the architecture briefing referencing top modules', () => {
    const repo = makeFakeCacheRepo({
      project: {
        repoPath, summary: 'A tool.', purpose: 'doing stuff', techStack: [],
        moduleMap: {}, triggerHashes: {}, confidence: 0.9,
      },
      modules: [
        { modulePath: 'payments', summary: 'Handles capture and idempotency for money movement.' },
        { modulePath: 'ledger', summary: 'Double-entry bookkeeping source of truth.' },
        { modulePath: 'webhooks', summary: 'Signed envelope fan-out to partners.' },
      ],
    });
    const composer = new BriefingComposer(repo, repoPath);
    const briefing = composer.composeArchitecture();

    expect(briefing).not.toBeNull();
    expect(briefing!.id).toBe('arch/root');
    expect(briefing!.layer).toBe('architecture');
    expect(briefing!.parent).toBe('project');
    expect(briefing!.children).toEqual(expect.arrayContaining([
      'module/payments', 'module/ledger', 'module/webhooks',
    ]));
    expect(briefing!.opener).toMatch(/3 modules|three modules/);
  });

  it('composes a module briefing with key-file mentions', () => {
    const repo = makeFakeCacheRepo({
      project: {
        repoPath, summary: '.', purpose: '', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9,
      },
      modules: [{
        modulePath: 'payments',
        summary: 'Handles capture and idempotency for money movement. Retries never double-charge.',
        keyFiles: ['payments/index.ts', 'payments/core.ts'],
      }],
    });
    const composer = new BriefingComposer(repo, repoPath);
    const briefing = composer.composeModule('payments');

    expect(briefing).not.toBeNull();
    expect(briefing!.id).toBe('module/payments');
    expect(briefing!.layer).toBe('module');
    expect(briefing!.parent).toBe('arch/root');
    expect(briefing!.opener).toMatch(/payments/i);
    expect(briefing!.opener).toMatch(/payments\/index\.ts|payments\/core\.ts/);
  });

  it('composeAll returns project + architecture + all modules', () => {
    const repo = makeFakeCacheRepo({
      project: {
        repoPath, summary: 'Something that does things.', purpose: 'a useful thing',
        techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9,
      },
      modules: [
        { modulePath: 'a', summary: 'A summary for module a.' },
        { modulePath: 'b', summary: 'A summary for module b.' },
      ],
    });
    const composer = new BriefingComposer(repo, repoPath);
    const all = composer.composeAll();
    const ids = all.map(b => b.id).sort();
    expect(ids).toEqual(['arch/root', 'module/a', 'module/b', 'project'].sort());
  });

  it('produces deterministic sourceHash for identical inputs', () => {
    const repo = makeFakeCacheRepo({
      project: { repoPath, summary: 'x', purpose: 'y', techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9 },
    });
    const composer = new BriefingComposer(repo, repoPath);
    const a = composer.composeProject()!;
    const b = composer.composeProject()!;
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it('avoids "X is ${tagline}" grammar when purpose is a verb-phrase', () => {
    const repo = makeFakeCacheRepo({
      project: {
        repoPath,
        summary: 'Tetherline is a local-first developer tool that keeps you tethered to a codebase moving faster than you can absorb.',
        purpose: 'Stay tethered to your codebase',
        techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9,
      },
    });
    const composer = new BriefingComposer(repo, repoPath);
    const briefing = composer.composeProject()!;
    // Must NOT read as "X is stay tethered" — use em-dash for taglines
    expect(briefing.opener).not.toMatch(/is stay/i);
    expect(briefing.opener).toMatch(/—\s*Stay tethered/);
  });

  it('avoids re-introducing the project name in the body when summary starts with it', () => {
    const repo = makeFakeCacheRepo({
      project: {
        repoPath,
        summary: 'MyProject is a delightful little tool. It does everything.',
        purpose: 'a lovely helper',
        techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9,
      },
    });
    const composer = new BriefingComposer(repo, repoPath);
    const briefing = composer.composeProject()!;
    // Should not have "MyProject is a lovely helper. MyProject is a delightful…"
    const occurrences = (briefing.opener.match(/MyProject is/gi) || []).length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('briefing openers stay under 45 seconds of spoken duration', () => {
    const repo = makeFakeCacheRepo({
      project: {
        repoPath,
        summary: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
        purpose: 'something very long that could exceed the cap',
        techStack: [], moduleMap: {}, triggerHashes: {}, confidence: 0.9,
      },
    });
    const composer = new BriefingComposer(repo, repoPath);
    const briefing = composer.composeProject()!;
    expect(briefing.estimatedSeconds).toBeLessThanOrEqual(45);
  });
});

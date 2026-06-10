import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Retriever } from '../../packages/backend/src/intelligence/retriever.js';
import type { ContextCacheRepository, FileCacheRow } from '../../packages/backend/src/db/repositories/context-cache-repo.js';
import { shouldEscalateToAgentic, isEscalationAffirmative } from '../../packages/backend/src/session/qa-router.js';

const SENTINEL = 'QUETZAL-ANCHOR-7341';
let repoDir: string;

function fileRow(filePath: string, over: Partial<FileCacheRow> = {}): FileCacheRow {
  return {
    repoPath: repoDir,
    filePath,
    summary: '',
    contentHash: 'x',
    connectivity: 1,
    role: 'other',
    confidence: 0.9,
    ...over,
  } as FileCacheRow;
}

function fakeRepo(files: FileCacheRow[], modules: Array<{ modulePath: string; summary: string; keyFiles: string[] }> = []): ContextCacheRepository {
  return {
    getFilesForRepo: () => files,
    getModulesForRepo: () => modules.map(m => ({
      repoPath: repoDir, modulePath: m.modulePath, summary: m.summary, source: 'llm',
      keyFiles: m.keyFiles, imports: [], confidence: 0.9, impactScore: 0,
    })),
    getProject: () => null,
    getModule: () => null,
    getFile: () => null,
    getQA: () => [],
  } as unknown as ContextCacheRepository;
}

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retriever-test-'));
  fs.writeFileSync(path.join(repoDir, 'README.md'),
    `# DocForge\n\nDocForge bakes documents into model weights. ${SENTINEL}\n\nNo install section here on purpose.\n`);
  fs.writeFileSync(path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'docforge', dependencies: { pandas: 'n/a' } }, null, 2));
  fs.mkdirSync(path.join(repoDir, 'src/core'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/core/capture.ts'),
    `// capture pipeline\nexport function capturePayment(key: string) {\n  return key; // idempotency-window\n}\n`);
  fs.writeFileSync(path.join(repoDir, 'src/core/big.ts'),
    'export const BLOB = `' + 'x'.repeat(20_000) + '`;\n');
});

afterAll(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe('Retriever', () => {
  it('docs-only repo: anchors only, README content present, hard-grounding instructions in the block', () => {
    const r = new Retriever(fakeRepo([fileRow('README.md', { role: 'docs' })]), repoDir);
    const out = r.retrieve({ question: 'how do I install this' });
    expect(out.confidence).toBe('anchors-only');
    expect(out.files.some(f => f.filePath === 'README.md' && f.reason === 'anchor')).toBe(true);
    expect(out.promptBlock).toContain(SENTINEL);
    expect(out.promptBlock).toContain("don't see it in the repo");
    expect(out.promptBlock).toContain('Never invent');
    // The manifest anchor came along too.
    expect(out.files.some(f => f.filePath === 'package.json')).toBe(true);
  });

  it('explicit classifier target resolves to the real file (target-hit)', () => {
    const rows = [fileRow('README.md'), fileRow('src/core/capture.ts', { role: 'entry', connectivity: 5 })];
    const r = new Retriever(fakeRepo(rows), repoDir);
    const out = r.retrieve({ question: 'what does capture do', params: { target: 'capture.ts' } });
    expect(out.confidence).toBe('target-hit');
    const hit = out.files.find(f => f.reason === 'explicit-target');
    expect(hit?.filePath).toBe('src/core/capture.ts');
    expect(hit?.content).toContain('capturePayment');
  });

  it('symbol targets resolve via grep over indexed code files', () => {
    const rows = [fileRow('src/core/capture.ts', { connectivity: 5 })];
    const r = new Retriever(fakeRepo(rows), repoDir);
    const out = r.retrieve({ question: 'explain it', params: { target: 'capturePayment' } });
    expect(out.confidence).toBe('target-hit');
    expect(out.files.some(f => f.filePath === 'src/core/capture.ts')).toBe(true);
  });

  it('keyword scoring matches by basename stem without an explicit target', () => {
    const rows = [
      fileRow('src/core/capture.ts', { summary: 'payment capture with idempotency' }),
      fileRow('src/core/big.ts'),
    ];
    const r = new Retriever(fakeRepo(rows), repoDir);
    const out = r.retrieve({ question: 'how does capture handle retries' });
    expect(out.confidence).toBe('matched');
    const kw = out.files.find(f => f.reason === 'keyword');
    expect(kw?.filePath).toBe('src/core/capture.ts');
  });

  it('respects file and token budgets and marks truncation', () => {
    const rows = Array.from({ length: 12 }, (_, i) => {
      const p = `src/mod/capture-helper-${i}.ts`;
      fs.mkdirSync(path.join(repoDir, 'src/mod'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, p), `// capture helper ${i}\n` + 'const line = 1;\n'.repeat(50));
      return fileRow(p, { summary: 'capture helper' });
    });
    rows.push(fileRow('src/core/big.ts', { summary: 'capture blob' }));
    const r = new Retriever(fakeRepo(rows), repoDir);
    const out = r.retrieve({ question: 'capture helpers overview', tokenBudget: 3000 });
    const nonAnchor = out.files.filter(f => f.reason !== 'anchor');
    expect(nonAnchor.length).toBeLessThanOrEqual(5);
    expect(out.tokensUsed).toBeLessThanOrEqual(3000 + 1500); // last add may overshoot by one file cap
    const big = out.files.find(f => f.filePath === 'src/core/big.ts');
    if (big) expect(big.truncated).toBe(true);
  });

  it('module key files top up the budget', () => {
    const rows = [fileRow('src/core/capture.ts')];
    const r = new Retriever(
      fakeRepo(rows, [{ modulePath: 'src/core', summary: 'capture pipeline module', keyFiles: ['src/core/capture.ts'] }]),
      repoDir,
    );
    const out = r.retrieve({ question: 'tell me about the pipeline module' });
    expect(out.files.some(f => f.filePath === 'src/core/capture.ts')).toBe(true);
  });
});

describe('qa-router phrases', () => {
  it.each([
    ['deep dive into the parser', true],
    ['can you do a deep-dive on auth', true],
    ['dig through the code for me', true],
    ['dig into the retry logic', true],
    ['actually read the code please', true],
    ['trace through the request path', true],
    ['investigate the flaky test', true],
    ['dive deeper', false],          // quick-command nav phrase, not escalation
    ['tell me more', false],
    ['go deeper on auth', false],
    ['what changed this week', false],
  ])('shouldEscalateToAgentic(%j) → %s', (text, expected) => {
    expect(shouldEscalateToAgentic(text)).toBe(expected);
  });

  it.each([
    ['yes', true],
    ['Yeah!', true],
    ['sure.', true],
    ['do it', true],
    ['go ahead', true],
    ['yes but only the auth part', false],
    ['no thanks', false],
    ['what about the readme', false],
  ])('isEscalationAffirmative(%j) → %s', (text, expected) => {
    expect(isEscalationAffirmative(text)).toBe(expected);
  });
});

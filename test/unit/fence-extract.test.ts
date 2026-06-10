/**
 * Fence extraction: code is NEVER spoken. These pin the pure utility used
 * by both the batch narration path and the streaming splitter's fence mode.
 */
import { describe, it, expect } from 'vitest';
import {
  extractFencedArtifacts,
  stripInlineBackticks,
  classifyArtifact,
  parseFenceBody,
} from '../../packages/backend/src/intelligence/fence-extract.js';

describe('extractFencedArtifacts', () => {
  it('lifts a complete bash fence out of prose', () => {
    const text = 'Install it like this:\n```bash\ngit clone repo\ncd repo\nnpm install\n```\nThat is all.';
    const { clean, artifacts } = extractFencedArtifacts(text);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].language).toBe('bash');
    expect(artifacts[0].code).toBe('git clone repo\ncd repo\nnpm install');
    expect(clean).not.toContain('`');
    expect(clean).toContain('Install it like this:');
    expect(clean).toContain('That is all.');
  });

  it('handles multiple fences in order', () => {
    const text = 'First:\n```sh\nnpm i\n```\nThen:\n```ts\nconst x = 1;\n```\nDone.';
    const { artifacts } = extractFencedArtifacts(text);
    expect(artifacts.map(a => a.language)).toEqual(['sh', 'ts']);
    expect(artifacts[1].code).toBe('const x = 1;');
  });

  it('an unterminated trailing fence still becomes an artifact', () => {
    const text = 'Run this:\n```bash\nnpm run dev';
    const { clean, artifacts } = extractFencedArtifacts(text);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].code).toBe('npm run dev');
    expect(clean).toBe('Run this:');
  });

  it('untagged fences work', () => {
    const { artifacts } = extractFencedArtifacts('Here:\n```\npnpm install\n```');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].language).toBe('');
    expect(artifacts[0].code).toBe('pnpm install');
  });

  it('text without fences passes through untouched', () => {
    const { clean, artifacts } = extractFencedArtifacts('Just a normal sentence about the core module.');
    expect(artifacts).toHaveLength(0);
    expect(clean).toBe('Just a normal sentence about the core module.');
  });
});

describe('classifyArtifact', () => {
  it('bash/sh/console → commands', () => {
    expect(classifyArtifact({ language: 'bash', code: 'anything' })).toBe('commands');
    expect(classifyArtifact({ language: 'sh', code: 'x' })).toBe('commands');
    expect(classifyArtifact({ language: 'console', code: 'x' })).toBe('commands');
  });
  it('typescript → code', () => {
    expect(classifyArtifact({ language: 'ts', code: 'const a = 1;' })).toBe('code');
  });
  it('untagged but command-shaped → commands', () => {
    expect(classifyArtifact({ language: '', code: 'npm install\ngit clone x\ncd x' })).toBe('commands');
  });
  it('untagged non-command content → code', () => {
    expect(classifyArtifact({ language: '', code: 'function hello() {\n  return 1;\n}' })).toBe('code');
  });
});

describe('stripInlineBackticks', () => {
  it('keeps content, drops backticks', () => {
    expect(stripInlineBackticks('run `npm i` before `npm run dev`')).toBe('run npm i before npm run dev');
  });
  it('idempotent and safe on stray backticks', () => {
    expect(stripInlineBackticks('weird ` stray')).toBe('weird  stray');
    expect(stripInlineBackticks('no ticks at all')).toBe('no ticks at all');
  });
});

describe('parseFenceBody', () => {
  it('first line is the language when it looks like one', () => {
    expect(parseFenceBody('bash\nnpm i')).toEqual({ language: 'bash', code: 'npm i' });
  });
  it('single-line body is code, not a language', () => {
    expect(parseFenceBody('npm install everything')).toEqual({ language: '', code: 'npm install everything' });
  });
});

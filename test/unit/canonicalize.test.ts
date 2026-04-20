import { describe, it, expect } from 'vitest';
import { canonicalize, hashRequest } from '../../packages/backend/src/intelligence/llm/canonicalize.js';

describe('canonicalize', () => {
  it('replaces ISO timestamps', () => {
    expect(canonicalize('Started at 2026-04-20T18:42:11Z'))
      .toContain('ISO_DATE_PLACEHOLDER');
  });

  it('replaces UUIDs', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(canonicalize(`Session ${id} is active`)).toContain('UUID_PLACEHOLDER');
  });

  it('replaces dev_ session ids', () => {
    expect(canonicalize('dev_1234567890abcdef is the id')).toContain('DEV_SESSION_PLACEHOLDER');
  });

  it('applies path rewrites', () => {
    const out = canonicalize('/home/david/coding-misc/interactive-reviewer/src/foo.ts', {
      pathRewrites: { '/home/david/coding-misc/interactive-reviewer': 'FIXTURE' },
    });
    expect(out).toBe('FIXTURE/src/foo.ts');
  });

  it('keeps plain English text intact', () => {
    const text = 'This is an ordinary sentence without special tokens.';
    expect(canonicalize(text)).toBe(text);
  });
});

describe('hashRequest', () => {
  const base = {
    model: 'claude-sonnet-4',
    system: 'You are an assistant.',
    maxTokens: 1024,
    messages: [{ role: 'user' as const, content: 'Hello world' }],
  };

  it('produces the same hash for identical requests', () => {
    expect(hashRequest(base)).toBe(hashRequest(base));
  });

  it('produces the same hash when only timestamps/UUIDs differ', () => {
    const a = { ...base, system: 'Started at 2026-04-20T18:42:11Z' };
    const b = { ...base, system: 'Started at 2030-01-01T00:00:00Z' };
    expect(hashRequest(a)).toBe(hashRequest(b));
  });

  it('produces a different hash when semantic content differs', () => {
    const a = { ...base, messages: [{ role: 'user' as const, content: 'Hello' }] };
    const b = { ...base, messages: [{ role: 'user' as const, content: 'Goodbye' }] };
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });
});

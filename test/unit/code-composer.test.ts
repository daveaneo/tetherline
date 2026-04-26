/**
 * Code-layer briefing composer — generates a spoken briefing from a
 * file's live content.
 *
 * Tests use tmp dirs so we exercise actual filesystem reads + symbol
 * extraction, not stub data. The point is to prove the composer can
 * produce a useful, TTS-safe briefing for a real piece of code with
 * real comments and real symbols.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { composeCodeBriefing } from '../../packages/backend/src/briefing/code-composer.js';

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'code-composer-'));
});
afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const p = path.join(repoPath, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe('composeCodeBriefing', () => {
  it('produces a code-layer briefing for a TypeScript file with multiple symbols', () => {
    write('src/auth.ts', `
/** Issue a short-lived JWT and rotate the signing key from the keyring. */
export function issueToken(userId: string): string {
  const key = pullKey();
  return signJwt(userId, key);
}

/** Pull the next signing key from the system keyring. */
export function pullKey(): string {
  return 'rotated-key';
}

function signJwt(userId: string, key: string): string {
  return \`tok_\${userId}_\${key}\`;
}
`);

    const result = composeCodeBriefing({ repoPath, filePath: 'src/auth.ts', symbol: 'issueToken' });
    expect(result).not.toBeNull();
    const { briefing, chunks } = result!;

    expect(briefing.layer).toBe('code');
    expect(briefing.id).toBe('code/src/auth.ts:issueToken');
    expect(briefing.parent).toBe('file/src/auth.ts');
    // Opener names the function + grabs the JSDoc gloss.
    expect(briefing.opener).toMatch(/issueToken/);
    expect(briefing.opener).toMatch(/JWT|keyring|rotate/i);
    expect(briefing.visualCue?.kind).toBe('code_panel');
    expect(briefing.visualCue?.ref).toBe('src/auth.ts');

    // Chunks cover all 3 functions, each with a non-empty range.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.range[0]).toBeGreaterThan(0);
      expect(c.range[1]).toBeGreaterThanOrEqual(c.range[0]);
      expect(c.voiceLine.length).toBeGreaterThan(10);
    }
  });

  it('matches symbol case-insensitively (so lowercased nav-vocab targets resolve)', () => {
    // Navigator-vocab lowercases utterance targets ("show me handleQuestion"
    // → target "handlequestion"). The composer must still find the
    // mixed-case symbol in the source.
    write('src/q.ts', `
/** Q&A entry point. */
export async function handleQuestion(question: string) { return question; }
`);
    const result = composeCodeBriefing({ repoPath, filePath: 'src/q.ts', symbol: 'handlequestion' });
    expect(result).not.toBeNull();
    expect(result!.briefing.opener).toMatch(/handleQuestion/);
  });

  it('returns null for a missing file', () => {
    expect(composeCodeBriefing({ repoPath, filePath: 'nonexistent.ts' })).toBeNull();
  });

  it('returns null for an empty file', () => {
    write('empty.ts', '');
    expect(composeCodeBriefing({ repoPath, filePath: 'empty.ts' })).toBeNull();
  });

  it('handles Python def/class without crashing (cross-language symbol extraction)', () => {
    write('lib.py', `
def fetch(url: str) -> dict:
    """Fetch a URL and parse JSON."""
    return {}

class Cache:
    """In-memory cache."""
    def get(self, k): return None
`);
    const result = composeCodeBriefing({ repoPath, filePath: 'lib.py' });
    expect(result).not.toBeNull();
    const names = result!.chunks.map(c => c.voiceLine.match(/\b(fetch|Cache|get)\b/i)?.[0]).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
  });

  it('source-hash changes when file content changes (drift detection support)', () => {
    write('a.ts', 'export const X = 1;');
    const v1 = composeCodeBriefing({ repoPath, filePath: 'a.ts' })!;
    write('a.ts', 'export const X = 2;');
    const v2 = composeCodeBriefing({ repoPath, filePath: 'a.ts' })!;
    expect(v1.briefing.sourceHash).not.toBe(v2.briefing.sourceHash);
  });

  it('estimatedSeconds stays inside the TTS-safe window (15-45s)', () => {
    write('a.ts', `
/** A function. */
export function doStuff() { return 1; }
`);
    const result = composeCodeBriefing({ repoPath, filePath: 'a.ts' })!;
    expect(result.briefing.estimatedSeconds).toBeGreaterThanOrEqual(15);
    expect(result.briefing.estimatedSeconds).toBeLessThanOrEqual(45);
  });
});

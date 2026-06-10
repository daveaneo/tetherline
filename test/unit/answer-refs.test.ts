import { describe, it, expect } from 'vitest';
import { extractRefs, parseRefsLine } from '../../packages/backend/src/intelligence/answer-refs.js';

describe('extractRefs', () => {
  it('strips a trailing REFS line and returns the names', () => {
    const { clean, refs } = extractRefs('The core module loads files. It dedupes them.\nREFS: core, file_loader.py');
    expect(clean).toBe('The core module loads files. It dedupes them.');
    expect(refs).toEqual(['core', 'file_loader.py']);
  });

  it('handles REFS: none', () => {
    const { clean, refs } = extractRefs('Short answer here.\nREFS: none');
    expect(clean).toBe('Short answer here.');
    expect(refs).toEqual([]);
  });

  it('tolerates a missing line', () => {
    const { clean, refs } = extractRefs('No refs line at all.');
    expect(clean).toBe('No refs line at all.');
    expect(refs).toEqual([]);
  });

  it('caps at 5 names and trims punctuation', () => {
    const { refs } = extractRefs('x\nREFS: a1, b2, c3, d4, e5, f6, g7.');
    expect(refs).toEqual(['a1', 'b2', 'c3', 'd4', 'e5']);
  });

  it('is case-insensitive on the marker and tolerant of whitespace', () => {
    const { clean, refs } = extractRefs('Answer.\n  refs:  core ;  auth  ');
    expect(clean).toBe('Answer.');
    expect(refs).toEqual(['core', 'auth']);
  });
});

describe('parseRefsLine', () => {
  it('parses the splitter-held line', () => {
    expect(parseRefsLine('REFS: core, loader')).toEqual(['core', 'loader']);
    expect(parseRefsLine('REFS: none')).toEqual([]);
    expect(parseRefsLine(null)).toEqual([]);
  });
});

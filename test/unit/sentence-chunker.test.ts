import { describe, it, expect } from 'vitest';
import { chunkAnswerForStreaming } from '../../packages/backend/src/intelligence/sentence-chunker.js';

describe('chunkAnswerForStreaming', () => {
  it('returns a single chunk for one-sentence answers', () => {
    expect(chunkAnswerForStreaming('Yes, that is right.')).toEqual(['Yes, that is right.']);
  });

  it('emits the first two sentences as standalone chunks for fast first-word time', () => {
    const text = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
    const chunks = chunkAnswerForStreaming(text);
    expect(chunks[0]).toBe('First sentence.');
    expect(chunks[1]).toBe('Second sentence.');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('groups later short sentences for rhythm without exceeding ~200 chars', () => {
    const text = [
      'A.', 'B.', // first two ship solo
      'Third short.', 'Fourth short.', 'Fifth short.', 'Sixth short.',
    ].join(' ');
    const chunks = chunkAnswerForStreaming(text);
    expect(chunks[0]).toBe('A.');
    expect(chunks[1]).toBe('B.');
    // Remaining short sentences should fold into 1 grouped chunk
    expect(chunks.length).toBe(3);
    expect(chunks[2]).toMatch(/Third short\..*Sixth short\./);
  });

  it('preserves order across all chunks', () => {
    const text = 'A. B. C. D. E.';
    const chunks = chunkAnswerForStreaming(text);
    const reassembled = chunks.join(' ');
    expect(reassembled.replace(/\s+/g, ' ').trim()).toBe('A. B. C. D. E.');
  });

  it('handles empty / whitespace input safely', () => {
    expect(chunkAnswerForStreaming('')).toEqual([]);
    expect(chunkAnswerForStreaming('   \n\n  ')).toEqual([]);
  });

  it('does not split mid-sentence on abbreviations', () => {
    // "e.g." should not break — we only split on sentence-end followed by
    // whitespace + capital letter / quote / paren.
    const chunks = chunkAnswerForStreaming('Use the auth flow, e.g. sign-in. Then redirect.');
    expect(chunks[0]).toMatch(/Use the auth flow.*sign-in\./);
  });
});

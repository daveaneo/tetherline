import { describe, it, expect } from 'vitest';
import { StreamingSentenceSplitter } from '../../packages/backend/src/intelligence/streaming-sentence-splitter.js';
import { chunkAnswerWithAnchors, type TaggedChunk } from '../../packages/backend/src/intelligence/sentence-chunker.js';

const ANSWER =
  'The loader reads files first. Then the cleaner dedupes them. ' +
  'After that the matcher scores models. It uses the hardware profile. ' +
  'Finally the resolver picks one. The result is written to disk.';

function runSplitter(deltas: string[], opts?: { maxSentences?: number; nodeLabels?: string[] }): {
  chunks: TaggedChunk[];
  splitter: StreamingSentenceSplitter;
} {
  const splitter = new StreamingSentenceSplitter({
    nodeLabels: opts?.nodeLabels ?? [],
    maxSentences: opts?.maxSentences,
  });
  const chunks: TaggedChunk[] = [];
  for (const d of deltas) chunks.push(...splitter.push(d));
  chunks.push(...splitter.flush());
  return { chunks, splitter };
}

describe('StreamingSentenceSplitter', () => {
  it('is invariant to delta fragmentation (char-by-char ≡ one blob)', () => {
    const oneBlob = runSplitter([ANSWER]).chunks.map(c => c.text);
    const charByChar = runSplitter(ANSWER.split('')).chunks.map(c => c.text);
    const words = runSplitter(ANSWER.split(/(?<= )/)).chunks.map(c => c.text);
    expect(charByChar).toEqual(oneBlob);
    expect(words).toEqual(oneBlob);
  });

  it('matches the batch chunker exactly for the same full text', () => {
    const batch = chunkAnswerWithAnchors(ANSWER, []).map(c => c.text);
    const streamed = runSplitter([ANSWER]).chunks.map(c => c.text);
    expect(streamed).toEqual(batch);
  });

  it('ships the first two sentences solo, then merges', () => {
    const { chunks } = runSplitter([ANSWER]);
    expect(chunks[0].text).toBe('The loader reads files first.');
    expect(chunks[1].text).toBe('Then the cleaner dedupes them.');
    // Remaining four short sentences merge under the 200-char budget.
    expect(chunks.length).toBeLessThan(6);
  });

  it('emits confirmed sentences before the stream ends', () => {
    const splitter = new StreamingSentenceSplitter({ nodeLabels: [] });
    const first = splitter.push('Sentence one is done. Sentence two has star');
    expect(first.map(c => c.text)).toEqual(['Sentence one is done.']);
    const second = splitter.push('ted and continues. And');
    expect(second.map(c => c.text)).toEqual(['Sentence two has started and continues.']);
  });

  it('caps at maxSentences, drops the tail, and reports capped', () => {
    const { chunks, splitter } = runSplitter([ANSWER], { maxSentences: 4 });
    const sentenceCount = chunks
      .flatMap(c => c.text.split(/(?<=[.!?])\s+/))
      .filter(Boolean).length;
    expect(sentenceCount).toBe(4);
    expect(splitter.capped).toBe(true);
    expect(splitter.sentenceCount).toBe(4);
    expect(chunks.map(c => c.text).join(' ')).not.toContain('resolver');
  });

  it('push() returns nothing after the cap is hit', () => {
    const splitter = new StreamingSentenceSplitter({ nodeLabels: [], maxSentences: 1 });
    expect(splitter.push('One. Two. ').length).toBeGreaterThan(0);
    expect(splitter.push('Three. Four. ')).toEqual([]);
    expect(splitter.flush()).toEqual([]);
  });

  it('flushes the buffered remainder as a final chunk', () => {
    const splitter = new StreamingSentenceSplitter({ nodeLabels: [] });
    splitter.push('Complete sentence here. Trailing fragment without termin');
    const flushed = splitter.flush();
    expect(flushed.map(c => c.text)).toEqual(['Trailing fragment without termin']);
  });

  it('holds back a trailing REFS line and never speaks it', () => {
    const splitter = new StreamingSentenceSplitter({ nodeLabels: [] });
    const out = [
      ...splitter.push('The core module does the work. It is small.\nREFS: core, loader'),
      ...splitter.flush(),
    ];
    expect(out.map(c => c.text).join(' ')).not.toMatch(/REFS:/i);
    expect(splitter.pendingRefsLine).toBe('REFS: core, loader');
  });

  it('captures a REFS line even when followed by stray text', () => {
    const splitter = new StreamingSentenceSplitter({ nodeLabels: [] });
    const out = [
      ...splitter.push('Answer sentence one.\n\nREFS: alpha\n\nStray trailing words.'),
      ...splitter.flush(),
    ];
    expect(out.map(c => c.text).join(' ')).not.toMatch(/REFS:/i);
    expect(splitter.pendingRefsLine).toBe('REFS: alpha');
  });

  it('tags chunks with anchors identically to the batch path', () => {
    const labels = ['loader', 'resolver'];
    const batch = chunkAnswerWithAnchors(ANSWER, labels);
    const streamed = runSplitter(ANSWER.split(/(?<= )/), { nodeLabels: labels }).chunks;
    expect(streamed).toEqual(batch);
  });

  it('handles a single-sentence answer via flush', () => {
    const { chunks } = runSplitter(['Just one sentence without much else']);
    expect(chunks.map(c => c.text)).toEqual(['Just one sentence without much else']);
  });

  it('handles empty input', () => {
    const { chunks } = runSplitter(['']);
    expect(chunks).toEqual([]);
  });
});

describe('StreamingSentenceSplitter — fence holdback (code is never spoken)', () => {
  const FENCED =
    'You can install it quickly. Here are the commands.\n' +
    '```bash\ngit clone repo\ncd repo\nnpm install\n```\n' +
    'After that it just works.';

  it('lifts the fence into artifacts; no chunk contains a backtick', () => {
    const { chunks, splitter } = runSplitter([FENCED]);
    expect(splitter.artifacts).toHaveLength(1);
    expect(splitter.artifacts[0]).toEqual({ language: 'bash', code: 'git clone repo\ncd repo\nnpm install' });
    for (const c of chunks) expect(c.text).not.toContain('`');
    const spoken = chunks.map(c => c.text).join(' ');
    expect(spoken).toContain('You can install it quickly.');
    expect(spoken).toContain('After that it just works.');
    expect(spoken).not.toContain('git clone');
  });

  it('is fragmentation-invariant WITH fences (char-by-char ≡ one blob, chunks AND artifacts)', () => {
    const blob = runSplitter([FENCED]);
    const chars = runSplitter(FENCED.split(''));
    const words = runSplitter(FENCED.split(/(?<= )/));
    expect(chars.chunks.map(c => c.text)).toEqual(blob.chunks.map(c => c.text));
    expect(words.chunks.map(c => c.text)).toEqual(blob.chunks.map(c => c.text));
    expect(chars.splitter.artifacts).toEqual(blob.splitter.artifacts);
    expect(words.splitter.artifacts).toEqual(blob.splitter.artifacts);
  });

  it('fence opener split across deltas behaves identically', () => {
    const { chunks, splitter } = runSplitter([
      'Here you go.\n``',
      '`bash\nnpm i\n``',
      '`\nDone now.',
    ]);
    expect(splitter.artifacts).toEqual([{ language: 'bash', code: 'npm i' }]);
    const spoken = chunks.map(c => c.text).join(' ');
    expect(spoken).toContain('Here you go.');
    expect(spoken).toContain('Done now.');
    expect(spoken).not.toContain('`');
  });

  it('an unterminated fence at stream end is still finalized at flush', () => {
    const { splitter } = runSplitter(['Run this:\n```bash\nnpm run dev']);
    expect(splitter.artifacts).toEqual([{ language: 'bash', code: 'npm run dev' }]);
  });

  it('fence content does not count toward the sentence cap', () => {
    // Cap 2: two prose sentences + a fence → capped only by prose.
    const text = 'One short sentence here. Another short sentence too.\n```bash\nnpm i\nnpm run dev\nnpm test\n```';
    const { splitter } = runSplitter([text], { maxSentences: 2 });
    expect(splitter.capped).toBe(true);
    expect(splitter.artifacts, 'fence after the cap point still captured').toHaveLength(1);
  });

  it('a fence arriving after the cap still becomes an artifact (already-open fence keeps accumulating)', () => {
    const splitter = new StreamingSentenceSplitter({ nodeLabels: [], maxSentences: 1 });
    const out: string[] = [];
    out.push(...splitter.push('First sentence ends. Second begins now and\n```bash\nnpm ').map(c => c.text));
    expect(splitter.capped).toBe(true);
    out.push(...splitter.push('install\n```\ntail prose.').map(c => c.text));
    splitter.flush();
    expect(splitter.artifacts).toEqual([{ language: 'bash', code: 'npm install' }]);
    expect(out.join(' ')).not.toContain('npm');
  });

  it('inline backticks are stripped from spoken chunks, content kept', () => {
    const { chunks } = runSplitter(['Run `npm i` before you start. Then check the `package.json` manifest.']);
    const spoken = chunks.map(c => c.text).join(' ');
    expect(spoken).toContain('npm i');
    expect(spoken).toContain('package.json');
    expect(spoken).not.toContain('`');
  });

  it('a REFS line after the fence is still held back', () => {
    const { chunks, splitter } = runSplitter([
      'Setup is two commands.\n```sh\nnpm i\n```\nREFS: core',
    ]);
    expect(splitter.pendingRefsLine).toBe('REFS: core');
    expect(splitter.artifacts).toHaveLength(1);
    expect(chunks.map(c => c.text).join(' ')).not.toContain('REFS');
  });

  it('fires onArtifact the moment the fence closes (mid-stream)', () => {
    const seen: string[] = [];
    const splitter = new StreamingSentenceSplitter({
      nodeLabels: [],
      onArtifact: a => seen.push(a.code),
    });
    splitter.push('Here:\n```bash\nnpm i\n');
    expect(seen).toHaveLength(0);
    splitter.push('```\nAnd more prose follows here.');
    expect(seen).toEqual(['npm i']);
  });
});

/**
 * Splits an answer into TTS-friendly chunks. Each chunk is one or more
 * complete sentences sized to feel snappy when read aloud:
 *  - never break mid-sentence
 *  - prefer 1 sentence per chunk for first 1-2 chunks (low first-word time)
 *  - merge subsequent short sentences so chunk N has rhythm
 *
 * Emits chunks in order so the frontend can queue and play them as audio
 * clips are ready.
 */

export interface TaggedChunk {
  text: string;
  /** Node labels mentioned in this chunk's text (case-insensitive,
   *  word-boundary match). Drives the karaoke-ball visual: as the
   *  chunk's TTS plays, the frontend pulses the matching diagram nodes
   *  so the user's eye follows the AI's words across the architecture
   *  map. */
  referencedNodes: string[];
}

/** First N sentences ship solo for fastest first-word time. */
export const SOLO_SENTENCE_COUNT = 2;
/** From sentence N on, short sentences merge until the buffer reaches this. */
export const MERGE_MAX_CHARS = 200;
/** Sentence boundary: terminator + whitespace + a started next sentence, or a blank line. */
export const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z"'(])|\n{2,}/;

/** Tag one chunk of text with the node labels it mentions. `sortedLabels`
 *  must be sorted longest-first so "FileLoader" matches before "File".
 *  Word-boundary, case-insensitive; labels may contain punctuation (file.py). */
export function tagChunkWithAnchors(text: string, sortedLabels: string[]): TaggedChunk {
  const found = new Set<string>();
  for (const label of sortedLabels) {
    // Escape regex metas; match as a whole word, case-insensitive.
    const safe = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Use lookarounds for non-word boundaries so "FileLoader" inside
    // "FileLoader." still matches.
    const re = new RegExp(`(^|[^A-Za-z0-9_])${safe}([^A-Za-z0-9_]|$)`, 'i');
    if (re.test(text)) found.add(label);
  }
  return { text, referencedNodes: [...found] };
}

/** Sort labels for tagChunkWithAnchors. */
export function sortLabelsForAnchoring(nodeLabels: string[]): string[] {
  return [...nodeLabels].sort((a, b) => b.length - a.length);
}

/** Tag chunks with the diagram-node labels they mention. `nodeLabels`
 *  is the set of currently-known node display names (e.g. ["core",
 *  "FileLoader", "PairGenerator"]) — the chunker matches on word
 *  boundary, case-insensitive. */
export function chunkAnswerWithAnchors(
  answer: string,
  nodeLabels: string[],
): TaggedChunk[] {
  const chunks = chunkAnswerForStreaming(answer);
  if (nodeLabels.length === 0) {
    return chunks.map(text => ({ text, referencedNodes: [] }));
  }
  const sorted = sortLabelsForAnchoring(nodeLabels);
  return chunks.map(text => tagChunkWithAnchors(text, sorted));
}

export function chunkAnswerForStreaming(answer: string): string[] {
  const sentences = splitIntoSentences(answer);
  if (sentences.length === 0) return [];
  if (sentences.length === 1) return sentences;

  const chunks: string[] = [];
  let buf = '';

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    // First sentences ship solo for fastest first-word time.
    if (i < SOLO_SENTENCE_COUNT) {
      chunks.push(s);
      continue;
    }
    // Group remaining short sentences together for rhythm.
    if (buf.length + s.length < MERGE_MAX_CHARS) {
      buf = buf ? `${buf} ${s}` : s;
    } else {
      if (buf) chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);

  return chunks;
}

export function splitIntoSentences(text: string): string[] {
  // Split on sentence terminators, but keep the punctuation. Also handle
  // newlines as soft breaks so list-style answers chunk reasonably.
  const parts = text
    .split(SENTENCE_BOUNDARY)
    .map(s => s.trim())
    .filter(Boolean);
  return parts;
}

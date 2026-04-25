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
export function chunkAnswerForStreaming(answer: string): string[] {
  const sentences = splitIntoSentences(answer);
  if (sentences.length === 0) return [];
  if (sentences.length === 1) return sentences;

  const chunks: string[] = [];
  let buf = '';

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    // First two sentences ship solo for fastest first-word time.
    if (i < 2) {
      chunks.push(s);
      continue;
    }
    // Group remaining short sentences (< 80 chars) together for rhythm.
    if (buf.length + s.length < 200) {
      buf = buf ? `${buf} ${s}` : s;
    } else {
      if (buf) chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);

  return chunks;
}

function splitIntoSentences(text: string): string[] {
  // Split on sentence terminators, but keep the punctuation. Also handle
  // newlines as soft breaks so list-style answers chunk reasonably.
  const parts = text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])|\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
  return parts;
}

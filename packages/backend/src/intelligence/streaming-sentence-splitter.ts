import {
  MERGE_MAX_CHARS,
  SENTENCE_BOUNDARY,
  SOLO_SENTENCE_COUNT,
  sortLabelsForAnchoring,
  tagChunkWithAnchors,
  type TaggedChunk,
} from './sentence-chunker.js';
import { parseFenceBody, stripInlineBackticks, type ExtractedArtifact } from './fence-extract.js';

export interface StreamingSplitterOptions {
  /** Anchor labels — same source as the batch chunker's nodeLabels. */
  nodeLabels: string[];
  /** Stop emitting after this many sentences; push() then returns [] and `capped` is set. */
  maxSentences?: number;
  /** Fired the moment a fence CLOSES mid-stream — lets the artifact card
   *  appear on screen while the answer is still speaking. */
  onArtifact?: (artifact: ExtractedArtifact) => void;
}

/** Fence opener at line start (optional indent). The backticks must be
 *  complete — a partial trailing "``" naturally stays in the buffer. */
const FENCE_OPEN = /(^|\n)[ \t]*```/;
/** How many buffer-tail chars to keep while inside a fence, so a closing
 *  marker fragmented across deltas ("\n``" + "`") can still be seen. */
const FENCE_TAIL_KEEP = 8;

/**
 * Incremental sentence splitter for token streams. Feed raw deltas with
 * push(); it returns chunks exactly as the batch chunker
 * (chunkAnswerForStreaming) would have produced them for the same full text —
 * the boundary regex requires the NEXT sentence to have started before the
 * previous one is confirmed, so output is invariant to delta fragmentation
 * (char-by-char ≡ one blob ≡ the non-streaming fallback).
 *
 * Fenced code blocks are NEVER spoken: a ``` fence flips the splitter into
 * fence mode, the body accumulates into an artifact (surfaced via
 * `artifacts` / the onArtifact callback), and fence content counts toward
 * neither sentences nor the cap. All fence decisions are made on the
 * ACCUMULATED buffer, never on delta boundaries — that is what preserves
 * the fragmentation invariant. Inline `backtick` spans are stripped from
 * spoken chunks (content kept).
 *
 * A trailing "REFS: …" line (the machine-read visual-refs protocol) is held
 * back and never emitted as speech; read it from `pendingRefsLine` after
 * flush().
 */
export class StreamingSentenceSplitter {
  private buffer = '';
  private pending = '';            // merge buffer for sentences ≥ SOLO_SENTENCE_COUNT
  private sentenceIndex = 0;       // absolute index of the next confirmed sentence
  private emittedSentences = 0;
  private readonly sortedLabels: string[];
  private readonly max: number;
  private readonly onArtifact?: (artifact: ExtractedArtifact) => void;
  private cappedFlag = false;
  private flushed = false;
  private fenceMode = false;
  private fenceBuf = '';
  /** The stripped REFS line (without trailing whitespace), if one was seen. */
  pendingRefsLine: string | null = null;
  /** Fenced blocks lifted out of the speech, in stream order. */
  readonly artifacts: ExtractedArtifact[] = [];

  constructor(opts: StreamingSplitterOptions) {
    this.sortedLabels = sortLabelsForAnchoring(opts.nodeLabels);
    this.max = opts.maxSentences ?? Infinity;
    this.onArtifact = opts.onArtifact;
  }

  get sentenceCount(): number {
    return this.emittedSentences;
  }

  get capped(): boolean {
    return this.cappedFlag;
  }

  /** Feed a raw delta; returns 0..n newly completed chunks. */
  push(delta: string): TaggedChunk[] {
    if (this.flushed) return [];
    // After the cap, speech is over — but an OPEN fence keeps accumulating
    // so flush() can still surface the artifact the user asked for.
    if (this.cappedFlag && !this.fenceMode) return [];
    this.buffer += delta;
    return this.drain(false);
  }

  /** End of stream: emit any buffered remainder (unless capped). */
  flush(): TaggedChunk[] {
    if (this.flushed) return [];
    const out = this.drain(true);
    this.flushed = true;

    // An unterminated fence still becomes an artifact — partial-on-screen
    // beats dropped, and it guarantees code is never spoken on abort.
    if (this.fenceMode) {
      this.fenceBuf += this.buffer;
      this.buffer = '';
      this.finalizeFence();
    }

    // Hold back a trailing REFS line — machine-read, never spoken.
    const refsMatch = this.buffer.match(/\n?\s*(REFS:\s*[^\n]*)\s*$/i);
    if (refsMatch) {
      this.pendingRefsLine = refsMatch[1].trim();
      this.buffer = this.buffer.slice(0, refsMatch.index).trimEnd();
    }
    if (this.cappedFlag) return out;

    const remainder = this.buffer.trim();
    this.buffer = '';
    if (remainder) out.push(...this.acceptSentence(remainder));
    if (!this.cappedFlag && this.pending) {
      out.push(this.tag(this.pending));
      this.pending = '';
    }
    return out;
  }

  /** Process the accumulated buffer: alternate between text mode (sentence
   *  confirmation) and fence mode (artifact accumulation). */
  private drain(atFlush: boolean): TaggedChunk[] {
    const out: TaggedChunk[] = [];
    for (;;) {
      if (this.fenceMode) {
        const close = this.buffer.match(/\n[ \t]*```/);
        if (close && close.index !== undefined) {
          this.fenceBuf += this.buffer.slice(0, close.index);
          this.buffer = this.buffer.slice(close.index + close[0].length);
          this.finalizeFence();
          continue; // back to text mode on the remainder
        }
        if (atFlush) return out; // flush() finalizes the partial fence
        // Keep only a short tail in the buffer (a fragmented closing
        // marker), move the rest into the fence body.
        if (this.buffer.length > FENCE_TAIL_KEEP) {
          this.fenceBuf += this.buffer.slice(0, -FENCE_TAIL_KEEP);
          this.buffer = this.buffer.slice(-FENCE_TAIL_KEEP);
        }
        return out;
      }

      const open = this.buffer.match(FENCE_OPEN);
      if (open && open.index !== undefined) {
        // The fence terminates the prose region, so everything before it
        // is CONFIRMED — including a final partial sentence.
        const prose = this.buffer.slice(0, open.index);
        this.buffer = this.buffer.slice(open.index + open[0].length);
        for (const raw of prose.split(SENTENCE_BOUNDARY)) {
          const sentence = raw.trim();
          if (!sentence) continue;
          if (!this.cappedFlag) out.push(...this.acceptSentence(sentence));
        }
        this.fenceMode = true;
        this.fenceBuf = '';
        continue;
      }

      // Plain text mode: all parts except the last are confirmed sentences;
      // the last may still grow (it also safely holds any partial "``").
      if (this.cappedFlag) return out;
      const parts = this.buffer.split(SENTENCE_BOUNDARY);
      if (parts.length <= 1) return out;
      this.buffer = parts[parts.length - 1];
      for (const raw of parts.slice(0, -1)) {
        const sentence = raw.trim();
        if (!sentence) continue;
        out.push(...this.acceptSentence(sentence));
        if (this.cappedFlag) break;
      }
      return out;
    }
  }

  private finalizeFence(): void {
    this.fenceMode = false;
    const artifact = parseFenceBody(this.fenceBuf);
    this.fenceBuf = '';
    if (artifact.code.length === 0) return;
    this.artifacts.push(artifact);
    this.onArtifact?.(artifact);
  }

  private acceptSentence(sentence: string): TaggedChunk[] {
    // Safety: a REFS line that the model didn't put last — capture, don't speak.
    if (/^REFS:/i.test(sentence)) {
      this.pendingRefsLine = sentence;
      return [];
    }
    const out: TaggedChunk[] = [];
    const i = this.sentenceIndex++;
    this.emittedSentences++;

    if (i < SOLO_SENTENCE_COUNT) {
      out.push(this.tag(sentence));
    } else if (this.pending.length + sentence.length < MERGE_MAX_CHARS) {
      this.pending = this.pending ? `${this.pending} ${sentence}` : sentence;
    } else {
      if (this.pending) out.push(this.tag(this.pending));
      this.pending = sentence;
    }

    if (this.emittedSentences >= this.max) {
      this.cappedFlag = true;
      // Emit whatever was accepted into the merge buffer so spoken text
      // matches the sentence count.
      if (this.pending) {
        out.push(this.tag(this.pending));
        this.pending = '';
      }
    }
    return out;
  }

  private tag(text: string): TaggedChunk {
    return tagChunkWithAnchors(stripInlineBackticks(text), this.sortedLabels);
  }
}

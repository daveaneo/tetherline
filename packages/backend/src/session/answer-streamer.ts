/**
 * Consumes a live LLM token stream and emits sentence chunks as they
 * complete — the single enforcement point for the spoken-answer length cap.
 * When the cap is reached the underlying stream is ABORTED (saving tokens;
 * the CLI client ignores maxTokens entirely) and the steering hook is
 * spoken instead, so the user steers depth rather than sitting through a
 * monologue. "Tell me more" then re-asks at the deeper tier.
 */
import type { LLMStreamHandle } from '../intelligence/llm/types.js';
import type { TaggedChunk } from '../intelligence/sentence-chunker.js';
import { StreamingSentenceSplitter } from '../intelligence/streaming-sentence-splitter.js';
import { classifyArtifact, type ExtractedArtifact } from '../intelligence/fence-extract.js';

export const STEERING_HOOK = 'Want me to go deeper?';

/** Spoken in place of fenced code — the code itself goes to the screen. */
export function artifactReplacementLine(artifacts: ExtractedArtifact[]): string {
  const kind = artifacts.some(a => classifyArtifact(a) === 'commands') ? 'commands' : 'code';
  return kind === 'commands'
    ? "I've put the commands on screen — copy them when you're ready."
    : "I've put the code on screen for you.";
}

export interface StreamAnswerOptions {
  streamId: string;
  /** 1 when an ack was already emitted as seq 0 of this stream. */
  startSeq: number;
  nodeLabels: string[];
  maxSentences: number;
  /** When true (default), a capped answer ends with the steering hook. */
  appendHookOnTruncate?: boolean;
  emitChunk: (chunk: TaggedChunk & { seq: number; isFinal: boolean }) => void;
  /** Fired the moment a fenced block closes mid-stream — the artifact card
   *  appears while the answer is still speaking. */
  onArtifact?: (artifact: ExtractedArtifact) => void;
}

export interface StreamAnswerResult {
  /** The spoken answer text (chunks joined; steering hook excluded). */
  fullText: string;
  truncated: boolean;
  sentenceCount: number;
  /** Held-back "REFS: …" machine line, if the model emitted one. */
  refsLine: string | null;
  /** Fenced blocks lifted out of the speech (already surfaced via
   *  onArtifact while streaming). */
  artifacts: ExtractedArtifact[];
}

export async function streamAnswerToChunks(
  handle: LLMStreamHandle,
  opts: StreamAnswerOptions,
): Promise<StreamAnswerResult> {
  const splitter = new StreamingSentenceSplitter({
    nodeLabels: opts.nodeLabels,
    maxSentences: opts.maxSentences,
    onArtifact: opts.onArtifact,
  });
  let seq = opts.startSeq;
  let held: TaggedChunk | null = null;
  const spoken: string[] = [];

  // One chunk of lookahead so the genuinely-last chunk carries isFinal.
  const emitHeld = (isFinal: boolean) => {
    if (!held) return;
    spoken.push(held.text);
    opts.emitChunk({ ...held, seq: seq++, isFinal });
    held = null;
  };
  const take = (chunks: TaggedChunk[]) => {
    for (const c of chunks) {
      emitHeld(false);
      held = c;
    }
  };

  try {
    for await (const delta of handle.deltas) {
      take(splitter.push(delta));
      if (splitter.capped) {
        handle.abort();
        break;
      }
    }
  } finally {
    // final never rejects after first token; swallow establishment-failure
    // duplicates (the deltas iterator already surfaced them to our caller).
    void handle.final.catch(() => { /* surfaced via deltas */ });
  }

  // flush() returns [] when capped but still captures a buffered REFS line
  // (and finalizes an unterminated fence into an artifact).
  take(splitter.flush());

  // The fenced content was lifted to the screen — say so, unless the
  // prose already does. One chunk, before the steering hook, so isFinal
  // bookkeeping stays unchanged.
  if (splitter.artifacts.length > 0) {
    const saysSo = spoken.some(t => /on (the |your )?screen/i.test(t)) ||
      (held !== null && /on (the |your )?screen/i.test((held as TaggedChunk).text));
    if (!saysSo) {
      emitHeld(false);
      held = { text: artifactReplacementLine(splitter.artifacts), referencedNodes: [] };
    }
  }

  const truncated = splitter.capped;
  if (truncated && (opts.appendHookOnTruncate ?? true)) {
    emitHeld(false);
    opts.emitChunk({ text: STEERING_HOOK, referencedNodes: [], seq: seq++, isFinal: true });
  } else {
    emitHeld(true);
  }

  return {
    fullText: spoken.join(' '),
    truncated,
    sentenceCount: splitter.sentenceCount,
    refsLine: splitter.pendingRefsLine,
    artifacts: [...splitter.artifacts],
  };
}

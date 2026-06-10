import type Anthropic from '@anthropic-ai/sdk';

/**
 * Unified LLM request — covers both text completions and tool-use structured calls.
 * All request-shaping lives at this boundary so adapters/cassettes see a single shape.
 */
export interface LLMRequest {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  /** For structured calls: forces the model to invoke a specific tool and return its `input`. */
  tool?: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
}

export interface LLMResponse {
  /** Raw text content (joined text blocks). Empty if the response was a tool_use only. */
  text: string;
  /** Parsed tool input (only when request.tool was specified). */
  toolInput?: unknown;
  /** Usage from the model for accounting. */
  usage?: { inputTokens: number; outputTokens: number };
  /** True if served from a cassette / cache rather than a live API call. */
  cacheHit: boolean;
  /** Backend-assigned id, useful for cassette keying and trace correlation. */
  id: string;
  /** Milliseconds the call took (wall-clock from complete()). */
  elapsedMs: number;
  /** True when the stream was aborted before completion; `text` holds what arrived. */
  aborted?: boolean;
}

/**
 * Handle over a live token stream. Contract:
 * - `deltas` yields raw text fragments in arrival order and yields at least once
 *   (a non-streaming fallback yields the whole completion as one delta).
 * - `final` resolves with the same LLMResponse shape complete() returns and
 *   NEVER rejects on abort — after abort() it resolves with the text received
 *   so far and `aborted: true`. Mid-stream transport errors likewise resolve
 *   with partial text rather than rejecting. Only establishment failures
 *   (no tokens ever arrived) may reject — callers treat that as a normal
 *   LLM error.
 * - `abort()` is idempotent and cancels the underlying API stream / subprocess.
 */
export interface LLMStreamHandle {
  deltas: AsyncIterable<string>;
  final: Promise<LLMResponse>;
  abort(): void;
}

export interface LLMAdapter {
  name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
  /**
   * Optional true token streaming. Callers must go through streamLLM() in
   * llm/index.ts, never call this directly — streamLLM provides the
   * complete()-based fallback for adapters that don't implement it.
   */
  stream?(req: LLMRequest): LLMStreamHandle;
}

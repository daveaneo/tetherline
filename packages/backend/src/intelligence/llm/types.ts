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
}

export interface LLMAdapter {
  name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

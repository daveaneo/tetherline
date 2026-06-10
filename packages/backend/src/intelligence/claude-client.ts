import type Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, LLMRequest, LLMStreamHandle } from './llm/index.js';
import { AnthropicLLMAdapter, getDefaultLLMAdapter, streamLLM } from './llm/index.js';

/**
 * Thin wrapper over an LLMAdapter that preserves the call shape the rest of
 * the codebase expects (`streamText` + `structuredCall`). The adapter is
 * pluggable so tests can install a cassette or mock without touching callers.
 */
export class ClaudeClient {
  private adapter: LLMAdapter;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-20250514') {
    this.model = model;
    // Honor the globally installed test adapter if one is set; otherwise use the real API.
    const fromDefault = getDefaultLLMAdapter();
    this.adapter = fromDefault ?? new AnthropicLLMAdapter(apiKey);
  }

  /** Escape hatch for tests: replace the adapter after construction. */
  setAdapter(adapter: LLMAdapter) {
    this.adapter = adapter;
  }

  async streamText(params: {
    system: string;
    messages: Anthropic.MessageParam[];
    maxTokens?: number;
    model?: string;
  }): Promise<string> {
    const req: LLMRequest = {
      model: params.model ?? this.model,
      system: params.system,
      messages: params.messages,
      maxTokens: params.maxTokens ?? 4096,
    };
    const resp = await this.adapter.complete(req);
    return resp.text;
  }

  /**
   * True token streaming variant of streamText. Falls back to a single-delta
   * stream when the installed adapter (cassette/mock) has no native stream().
   */
  streamTextLive(params: {
    system: string;
    messages: Anthropic.MessageParam[];
    maxTokens?: number;
    model?: string;
  }): LLMStreamHandle {
    return streamLLM(this.adapter, {
      model: params.model ?? this.model,
      system: params.system,
      messages: params.messages,
      maxTokens: params.maxTokens ?? 4096,
    });
  }

  async structuredCall<T>(params: {
    system: string;
    messages: Anthropic.MessageParam[];
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
    model?: string;
  }): Promise<T> {
    const req: LLMRequest = {
      model: params.model ?? this.model,
      system: params.system,
      messages: params.messages,
      maxTokens: params.maxTokens ?? 8192,
      tool: {
        name: params.toolName,
        description: params.toolDescription,
        inputSchema: params.inputSchema,
      },
    };
    const resp = await this.adapter.complete(req);
    if (resp.toolInput === undefined) {
      throw new Error(`LLM adapter returned no toolInput for tool "${params.toolName}"`);
    }
    return resp.toolInput as T;
  }
}

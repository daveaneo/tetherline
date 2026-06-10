/**
 * Common interface for Claude clients.
 * Both ClaudeClient (API) and ClaudeCodeClient (CLI) implement this.
 */
export interface IClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface IClaudeClient {
  streamText(params: {
    system: string;
    messages: IClaudeMessage[];
    maxTokens?: number;
    /** Per-call model override (e.g. Haiku for intent classification). */
    model?: string;
  }): Promise<string>;

  /** True token streaming (both concrete clients implement it; optional
   *  so lightweight test doubles don't have to). */
  streamTextLive?(params: {
    system: string;
    messages: IClaudeMessage[];
    maxTokens?: number;
    model?: string;
  }): import('./llm/types.js').LLMStreamHandle;

  structuredCall<T>(params: {
    system: string;
    messages: IClaudeMessage[];
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
    /** Per-call model override (e.g. Haiku for intent classification). */
    model?: string;
  }): Promise<T>;
}

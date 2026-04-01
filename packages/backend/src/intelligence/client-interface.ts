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
  }): Promise<string>;

  structuredCall<T>(params: {
    system: string;
    messages: IClaudeMessage[];
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<T>;
}

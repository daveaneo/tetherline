import Anthropic from '@anthropic-ai/sdk';

export class ClaudeClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  /** Get a full text response (non-streaming, returns concatenated text). */
  async streamText(params: {
    system: string;
    messages: Anthropic.MessageParam[];
    maxTokens?: number;
  }): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens ?? 4096,
      system: params.system,
      messages: params.messages,
    });

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');
  }

  /** Get structured JSON output via tool_use (forces the model to call a tool). */
  async structuredCall<T>(params: {
    system: string;
    messages: Anthropic.MessageParam[];
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<T> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens ?? 8192,
      system: params.system,
      messages: params.messages,
      tools: [{
        name: params.toolName,
        description: params.toolDescription,
        input_schema: params.inputSchema as Anthropic.Tool['input_schema'],
      }],
      tool_choice: { type: 'tool' as const, name: params.toolName },
    });

    const toolBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
    if (!toolBlock) throw new Error('No tool use block in response');
    return toolBlock.input as T;
  }
}

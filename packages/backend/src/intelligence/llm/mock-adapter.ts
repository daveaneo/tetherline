import type { LLMAdapter, LLMRequest, LLMResponse } from './types.js';

/**
 * Lightweight adapter for tests that want hand-written responses rather than
 * real recordings. Register matchers against the request and return a canned
 * response. First matching handler wins.
 */
export class MockLLMAdapter implements LLMAdapter {
  name = 'mock';
  private handlers: Array<{
    match: (req: LLMRequest) => boolean;
    response: Partial<LLMResponse> & { text?: string; toolInput?: unknown };
  }> = [];
  private calls: LLMRequest[] = [];

  on(match: (req: LLMRequest) => boolean, response: Partial<LLMResponse> & { text?: string; toolInput?: unknown }) {
    this.handlers.push({ match, response });
    return this;
  }

  /** Handle the tool-call path by tool name. */
  onTool(toolName: string, toolInput: unknown) {
    return this.on(req => req.tool?.name === toolName, { toolInput });
  }

  /** Handle any text completion with this fixed text. */
  onText(predicate: (req: LLMRequest) => boolean, text: string) {
    return this.on(predicate, { text });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const handler = this.handlers.find(h => h.match(req));
    if (!handler) {
      throw new Error(`MockLLMAdapter: no matcher for request (tool=${req.tool?.name ?? 'none'}, system preview: "${req.system.slice(0, 120)}")`);
    }
    return {
      id: `llm_mock_${this.calls.length}`,
      text: handler.response.text ?? '',
      toolInput: handler.response.toolInput,
      usage: { inputTokens: 0, outputTokens: 0 },
      cacheHit: false,
      elapsedMs: 0,
      ...handler.response,
    };
  }

  getCalls(): LLMRequest[] {
    return [...this.calls];
  }

  reset() {
    this.handlers = [];
    this.calls = [];
  }
}

import { randomBytes } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, LLMRequest, LLMResponse, LLMStreamHandle } from './types.js';
import { trace } from '../../dev/trace.js';

export class AnthropicLLMAdapter implements LLMAdapter {
  name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const t0 = Date.now();
    const id = `llm_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;

    const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user');
    const lastUserText = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
        : '';
    trace({
      kind: 'llm.request',
      sessionId: null,
      payload: {
        id,
        model: req.model,
        hasTool: !!req.tool,
        toolName: req.tool?.name,
        maxTokens: req.maxTokens,
        system: req.system ?? '',
        lastUserMessage: lastUserText,
      },
    });

    const response = await this.withRetry(() => this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      ...(req.tool ? {
        tools: [{
          name: req.tool.name,
          description: req.tool.description,
          input_schema: req.tool.inputSchema as Anthropic.Tool['input_schema'],
        }],
        tool_choice: { type: 'tool' as const, name: req.tool.name },
      } : {}),
    }));

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const toolBlock = req.tool
      ? response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      : undefined;

    const result: LLMResponse = {
      id,
      text,
      toolInput: toolBlock?.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      cacheHit: false,
      elapsedMs: Date.now() - t0,
    };

    trace({
      kind: 'llm.response',
      sessionId: null,
      durationMs: result.elapsedMs,
      payload: {
        id,
        cacheHit: false,
        tokens: result.usage,
        text,
        toolInput: toolBlock?.input,
      },
    });

    return result;
  }

  /**
   * True token streaming. Text-only — structured (tool) calls stay on
   * complete(). `final` resolves with partial text + aborted:true on abort
   * or mid-stream error; it only rejects if the stream could not be
   * established at all.
   */
  stream(req: LLMRequest): LLMStreamHandle {
    const t0 = Date.now();
    const id = `llm_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;

    const lastUserMsg = [...req.messages].reverse().find(m => m.role === 'user');
    const lastUserText = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
        : '';
    trace({
      kind: 'llm.request',
      sessionId: null,
      payload: {
        id,
        model: req.model,
        hasTool: false,
        maxTokens: req.maxTokens,
        streaming: true,
        system: req.system ?? '',
        lastUserMessage: lastUserText,
      },
    });

    const s = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
    });

    let received = '';
    let aborted = false;
    let firstTokenSeen = false;

    const deltas = (async function* () {
      try {
        for await (const event of s) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            firstTokenSeen = true;
            received += event.delta.text;
            yield event.delta.text;
          }
        }
      } catch (err) {
        // Abort or mid-stream transport error: end the iterator quietly if any
        // token arrived; surface establishment failures to the consumer.
        if (!aborted && !firstTokenSeen) throw err;
      }
    })();

    const final: Promise<LLMResponse> = s.finalMessage()
      .then((msg): LLMResponse => ({
        id,
        text: msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join(''),
        usage: {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
        },
        cacheHit: false,
        elapsedMs: Date.now() - t0,
      }))
      .catch((err): LLMResponse => {
        if (!aborted && !firstTokenSeen) throw err;
        return {
          id,
          text: received,
          cacheHit: false,
          elapsedMs: Date.now() - t0,
          aborted: true,
        };
      })
      .then(result => {
        trace({
          kind: 'llm.response',
          sessionId: null,
          durationMs: result.elapsedMs,
          payload: {
            id,
            cacheHit: false,
            tokens: result.usage,
            text: result.text,
            aborted: result.aborted ?? false,
          },
        });
        return result;
      });

    return {
      deltas,
      final,
      abort() {
        if (aborted) return;
        aborted = true;
        s.abort();
      },
    };
  }

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try { return await fn(); }
      catch (err: any) {
        lastError = err;
        if (err.status === 401 || err.status === 400) throw err;
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }
    throw lastError;
  }
}

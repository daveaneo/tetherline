import type { LLMAdapter, LLMRequest, LLMResponse, LLMStreamHandle } from './types.js';

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
    /** Delay before complete() resolves / before the first stream delta. */
    delayMs?: number;
    /** When set, stream() emits these deltas in order instead of one blob. */
    streamDeltas?: string[];
    /** Pause between consecutive stream deltas. */
    interDelayMs?: number;
  }> = [];
  private calls: LLMRequest[] = [];
  private abortedStreams: LLMRequest[] = [];

  on(
    match: (req: LLMRequest) => boolean,
    response: Partial<LLMResponse> & { text?: string; toolInput?: unknown },
    opts?: { delayMs?: number },
  ) {
    this.handlers.push({ match, response, delayMs: opts?.delayMs });
    return this;
  }

  /** Handle the tool-call path by tool name. */
  onTool(toolName: string, toolInput: unknown, opts?: { delayMs?: number }) {
    return this.on(req => req.tool?.name === toolName, { toolInput }, opts);
  }

  /** Handle any text completion with this fixed text. */
  onText(predicate: (req: LLMRequest) => boolean, text: string, opts?: { delayMs?: number }) {
    return this.on(predicate, { text }, opts);
  }

  /**
   * Handle a text request with timed streaming deltas. complete() on the same
   * matcher returns the joined text, so the handler works on both paths.
   */
  onTextStream(
    predicate: (req: LLMRequest) => boolean,
    deltas: string[],
    interDelayMs = 0,
    opts?: { delayMs?: number },
  ) {
    this.handlers.push({
      match: predicate,
      response: { text: deltas.join('') },
      streamDeltas: deltas,
      interDelayMs,
      delayMs: opts?.delayMs,
    });
    return this;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const handler = this.handlers.find(h => h.match(req));
    if (!handler) {
      throw new Error(`MockLLMAdapter: no matcher for request (tool=${req.tool?.name ?? 'none'}, system preview: "${req.system.slice(0, 120)}")`);
    }
    if (handler.delayMs) await new Promise(r => setTimeout(r, handler.delayMs));
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

  stream(req: LLMRequest): LLMStreamHandle {
    this.calls.push(req);
    const handler = this.handlers.find(h => h.match(req));
    if (!handler) {
      throw new Error(`MockLLMAdapter: no matcher for stream request (system preview: "${req.system.slice(0, 120)}")`);
    }
    const deltas = handler.streamDeltas ?? [handler.response.text ?? ''];
    const interDelay = handler.interDelayMs ?? 0;
    const initialDelay = handler.delayMs ?? 0;
    const id = `llm_mock_${this.calls.length}`;

    let aborted = false;
    let received = '';
    const self = this;

    let settle!: () => void;
    const settled = new Promise<void>(r => { settle = r; });

    // The consumer drives the generator; its finally block settles `final`
    // whether iteration completes, aborts mid-way, or is abandoned (return()).
    async function* gen() {
      try {
        if (initialDelay) await new Promise(r => setTimeout(r, initialDelay));
        for (const [i, d] of deltas.entries()) {
          if (aborted) return;
          if (i > 0 && interDelay) await new Promise(r => setTimeout(r, interDelay));
          if (aborted) return;
          received += d;
          if (d) yield d;
        }
      } finally {
        settle();
      }
    }
    const iterator = gen();

    const final: Promise<LLMResponse> = settled.then(() => ({
      id,
      text: aborted ? received : deltas.join(''),
      usage: { inputTokens: 0, outputTokens: 0 },
      cacheHit: false,
      elapsedMs: 0,
      ...(aborted ? { aborted: true } : {}),
    }));

    return {
      deltas: iterator,
      final,
      abort: () => {
        if (aborted) return;
        aborted = true;
        self.abortedStreams.push(req);
      },
    };
  }

  getCalls(): LLMRequest[] {
    return [...this.calls];
  }

  /** Requests whose stream handle was abort()ed (e.g. by the sentence cap). */
  getAbortedStreams(): LLMRequest[] {
    return [...this.abortedStreams];
  }

  reset() {
    this.handlers = [];
    this.calls = [];
    this.abortedStreams = [];
  }
}

export { type LLMAdapter, type LLMRequest, type LLMResponse, type LLMStreamHandle } from './types.js';
export { AnthropicLLMAdapter } from './anthropic-adapter.js';
export { CassetteLLMAdapter, CassetteMissError, resolveRecordMode, showRecordBannerIfNeeded, type RecordMode, type CassetteOptions } from './cassette-adapter.js';
export { MockLLMAdapter } from './mock-adapter.js';
export { canonicalizeRequest, hashRequest, canonicalize } from './canonicalize.js';

import type { LLMAdapter, LLMRequest, LLMStreamHandle } from './types.js';

/**
 * Uniform streaming entry point: native adapter stream when available,
 * otherwise a fallback that runs complete() and yields the whole text as a
 * single delta. Cassette/mock adapters therefore "stream" for free with
 * byte-identical downstream behavior (the sentence splitter is
 * fragmentation-invariant), just without the latency win.
 */
export function streamLLM(adapter: LLMAdapter, req: LLMRequest): LLMStreamHandle {
  if (adapter.stream) return adapter.stream(req);

  let aborted = false;
  const completion = adapter.complete(req);
  // Abort cannot cancel a complete() in flight; it only suppresses the delta.
  const final = completion.then(r => (aborted ? { ...r, aborted: true } : r));
  async function* gen() {
    const r = await completion;
    if (!aborted && r.text) yield r.text;
  }
  return {
    deltas: gen(),
    final,
    abort() { aborted = true; },
  };
}

/**
 * Global default adapter. In production this is the Anthropic live adapter.
 * Tests override it before importing anything that triggers LLM calls.
 */
let _default: LLMAdapter | null = null;

export function setDefaultLLMAdapter(a: LLMAdapter | null) {
  _default = a;
}

export function getDefaultLLMAdapter(): LLMAdapter | null {
  return _default;
}

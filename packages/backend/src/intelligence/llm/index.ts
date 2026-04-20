export { type LLMAdapter, type LLMRequest, type LLMResponse } from './types.js';
export { AnthropicLLMAdapter } from './anthropic-adapter.js';
export { CassetteLLMAdapter, CassetteMissError, resolveRecordMode, showRecordBannerIfNeeded, type RecordMode, type CassetteOptions } from './cassette-adapter.js';
export { MockLLMAdapter } from './mock-adapter.js';
export { canonicalizeRequest, hashRequest, canonicalize } from './canonicalize.js';

import type { LLMAdapter } from './types.js';

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

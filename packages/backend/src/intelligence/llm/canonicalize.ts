import { createHash } from 'crypto';
import type { LLMRequest } from './types.js';

/**
 * Normalize non-deterministic inputs before hashing so semantically identical
 * requests always hit the same cassette. Prevents the cache from fragmenting
 * on every session id / timestamp / ULID variation.
 */
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const NANOID_RE = /\b[A-Za-z0-9_-]{20,24}\b/g;
const DEV_SESSION_RE = /\bdev_[0-9a-f]{16}\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const EPOCH_RE = /"timestamp"\s*:\s*\d{10,}/g;

export function canonicalize(text: string, opts: { pathRewrites?: Record<string, string> } = {}): string {
  let t = text;
  t = t.replace(UUID_RE, 'UUID_PLACEHOLDER');
  t = t.replace(ULID_RE, 'ULID_PLACEHOLDER');
  t = t.replace(DEV_SESSION_RE, 'DEV_SESSION_PLACEHOLDER');
  t = t.replace(ISO_DATE_RE, 'ISO_DATE_PLACEHOLDER');
  t = t.replace(EPOCH_RE, '"timestamp":EPOCH_PLACEHOLDER');
  t = t.replace(NANOID_RE, (match) => {
    // Only rewrite if it looks like a nanoid (mix of casing/digits)
    return /[a-z]/.test(match) && /[A-Z0-9]/.test(match) ? 'NANOID_PLACEHOLDER' : match;
  });
  for (const [from, to] of Object.entries(opts.pathRewrites ?? {})) {
    t = t.split(from).join(to);
  }
  return t;
}

export function canonicalizeRequest(req: LLMRequest, pathRewrites?: Record<string, string>): LLMRequest {
  const system = canonicalize(req.system, { pathRewrites });
  const messages = req.messages.map(m => ({
    ...m,
    content: typeof m.content === 'string'
      ? canonicalize(m.content, { pathRewrites })
      : m.content.map(block => {
          if (block.type === 'text') {
            return { ...block, text: canonicalize(block.text, { pathRewrites }) };
          }
          return block;
        }),
  })) as LLMRequest['messages'];
  return { ...req, system, messages };
}

export function hashRequest(req: LLMRequest, pathRewrites?: Record<string, string>): string {
  const canonical = canonicalizeRequest(req, pathRewrites);
  const str = JSON.stringify({
    model: canonical.model,
    system: canonical.system,
    messages: canonical.messages,
    tool: canonical.tool,
    maxTokens: canonical.maxTokens,
  });
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

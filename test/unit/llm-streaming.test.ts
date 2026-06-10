import { describe, it, expect } from 'vitest';
import { streamLLM, MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';
import type { LLMRequest } from '../../packages/backend/src/intelligence/llm/index.js';

const REQ: LLMRequest = {
  model: 'claude-test',
  system: 'sys',
  messages: [{ role: 'user', content: 'q' }],
  maxTokens: 100,
};

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

describe('streamLLM', () => {
  it('falls back to complete() as a single delta when the adapter has no stream()', async () => {
    const mock = new MockLLMAdapter();
    mock.onText(() => true, 'whole answer here');
    // Strip the native stream() so the fallback path is exercised.
    const noStream = { name: 'x', complete: mock.complete.bind(mock) };
    const handle = streamLLM(noStream, REQ);
    expect(await collect(handle.deltas)).toEqual(['whole answer here']);
    const final = await handle.final;
    expect(final.text).toBe('whole answer here');
    expect(final.aborted).toBeUndefined();
  });

  it('fallback abort suppresses the delta and marks final aborted', async () => {
    const mock = new MockLLMAdapter();
    mock.onText(() => true, 'whole answer here', { delayMs: 30 });
    const noStream = { name: 'x', complete: mock.complete.bind(mock) };
    const handle = streamLLM(noStream, REQ);
    handle.abort();
    expect(await collect(handle.deltas)).toEqual([]);
    const final = await handle.final;
    expect(final.aborted).toBe(true);
  });

  it('uses the adapter native stream() when present', async () => {
    const mock = new MockLLMAdapter();
    mock.onTextStream(() => true, ['one ', 'two ', 'three'], 5);
    const handle = streamLLM(mock, REQ);
    expect(await collect(handle.deltas)).toEqual(['one ', 'two ', 'three']);
    const final = await handle.final;
    expect(final.text).toBe('one two three');
    expect(final.aborted).toBeUndefined();
  });
});

describe('MockLLMAdapter.stream', () => {
  it('abort mid-stream ends iteration, resolves final with partial text, records the abort', async () => {
    const mock = new MockLLMAdapter();
    mock.onTextStream(() => true, ['alpha ', 'beta ', 'gamma'], 10);
    const handle = mock.stream(REQ);

    const got: string[] = [];
    for await (const d of handle.deltas) {
      got.push(d);
      if (got.length === 2) handle.abort();
    }
    expect(got).toEqual(['alpha ', 'beta ']);

    const final = await handle.final;
    expect(final.aborted).toBe(true);
    expect(final.text).toBe('alpha beta ');
    expect(mock.getAbortedStreams()).toHaveLength(1);
  });

  it('abort() is idempotent', async () => {
    const mock = new MockLLMAdapter();
    mock.onTextStream(() => true, ['a', 'b'], 5);
    const handle = mock.stream(REQ);
    handle.abort();
    handle.abort();
    expect(await collect(handle.deltas)).toEqual([]);
    expect(mock.getAbortedStreams()).toHaveLength(1);
    const final = await handle.final;
    expect(final.aborted).toBe(true);
  });

  it('records stream requests in getCalls()', async () => {
    const mock = new MockLLMAdapter();
    mock.onTextStream(() => true, ['x']);
    const handle = mock.stream(REQ);
    await collect(handle.deltas);
    await handle.final;
    expect(mock.getCalls()).toHaveLength(1);
    expect(mock.getCalls()[0].model).toBe('claude-test');
  });
});

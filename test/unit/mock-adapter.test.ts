import { describe, it, expect } from 'vitest';
import { MockLLMAdapter } from '../../packages/backend/src/intelligence/llm/index.js';

describe('MockLLMAdapter', () => {
  it('returns registered tool input for matching tool calls', async () => {
    const mock = new MockLLMAdapter();
    mock.onTool('classify_intent', { skillName: 'navigate', confidence: 1, params: {} });

    const result = await mock.complete({
      model: 'x', system: 's', maxTokens: 100,
      messages: [],
      tool: { name: 'classify_intent', description: '', inputSchema: {} },
    });

    expect(result.toolInput).toEqual({ skillName: 'navigate', confidence: 1, params: {} });
    expect(result.cacheHit).toBe(false);
  });

  it('returns registered text for matching text calls', async () => {
    const mock = new MockLLMAdapter();
    mock.onText(req => req.system.includes('code review'), 'Here is my review.');

    const result = await mock.complete({
      model: 'x', system: 'You are doing code review.', maxTokens: 100,
      messages: [],
    });

    expect(result.text).toBe('Here is my review.');
  });

  it('throws when no handler matches', async () => {
    const mock = new MockLLMAdapter();
    await expect(mock.complete({
      model: 'x', system: 's', maxTokens: 100, messages: [],
    })).rejects.toThrow(/no matcher/);
  });

  it('records calls for assertion', async () => {
    const mock = new MockLLMAdapter();
    mock.on(() => true, { text: 'ok' });
    await mock.complete({ model: 'x', system: 'first', maxTokens: 10, messages: [] });
    await mock.complete({ model: 'x', system: 'second', maxTokens: 10, messages: [] });
    expect(mock.getCalls()).toHaveLength(2);
    expect(mock.getCalls()[1].system).toBe('second');
  });
});

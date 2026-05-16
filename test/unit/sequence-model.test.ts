import { describe, it, expect } from 'vitest';
import {
  buildSequenceModel,
  clampChain,
} from '../../packages/backend/src/intelligence/sequence-model.js';

describe('call-path sequence model', () => {
  it('participants are first-appearance order, NOT sorted (order is meaning)', () => {
    const m = buildSequenceModel([
      { from: 'handler', to: 'service' },
      { from: 'service', to: 'repo' },
      { from: 'service', to: 'cache' },
    ]);
    expect(m.participants).toEqual(['handler', 'service', 'repo', 'cache']);
  });

  it('messages preserve order and carry increasing call depth', () => {
    const m = buildSequenceModel([
      { from: 'a', to: 'b', label: 'load()' },
      { from: 'b', to: 'c', label: 'fetch()' },
    ]);
    expect(m.messages).toEqual([
      { from: 'a', to: 'b', label: 'load()', depth: 0 },
      { from: 'b', to: 'c', label: 'fetch()', depth: 1 },
    ]);
  });

  it('self-call (recursion) is kept and does not deepen the stack', () => {
    const m = buildSequenceModel([
      { from: 'fib', to: 'fib', label: 'fib(n-1)' },
      { from: 'fib', to: 'fib', label: 'fib(n-2)' },
    ]);
    expect(m.participants).toEqual(['fib']);
    expect(m.messages.map(x => x.depth)).toEqual([0, 0]); // self-calls don't nest
  });

  it('empty chain → empty model, never throws', () => {
    expect(buildSequenceModel([])).toEqual({ participants: [], messages: [] });
  });

  it('is deterministic', () => {
    const c = [{ from: 'x', to: 'y' }, { from: 'y', to: 'z' }];
    expect(buildSequenceModel(c)).toEqual(buildSequenceModel(c));
  });

  it('clampChain caps a pathological path (hairball guard)', () => {
    const big = Array.from({ length: 100 }, (_, i) => ({ from: `f${i}`, to: `f${i + 1}` }));
    expect(clampChain(big, 40)).toHaveLength(40);
    expect(clampChain(big.slice(0, 5), 40)).toHaveLength(5);
  });
});

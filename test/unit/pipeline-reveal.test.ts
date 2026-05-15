import { describe, it, expect } from 'vitest';
import {
  pipelineRevealOrder,
  isPipelineRequest,
  type RevealNode,
} from '../../packages/frontend/src/components/room/pipeline-reveal.js';

const N = (id: string, role?: string): RevealNode => ({ id, data: role ? { role } : {} });

describe('pipeline reveal order', () => {
  it('reveals strictly source → transform → guard → sink', () => {
    const order = pipelineRevealOrder([
      N('sink1', 'sink'),
      N('guard1', 'guard'),
      N('src1', 'source'),
      N('xf1', 'transform'),
    ]).map(n => n.id);
    expect(order).toEqual(['src1', 'xf1', 'guard1', 'sink1']);
  });

  it('preserves input order within the same role (edge order from extractor)', () => {
    const order = pipelineRevealOrder([
      N('xfB', 'transform'),
      N('xfA', 'transform'),
      N('src', 'source'),
    ]).map(n => n.id);
    expect(order).toEqual(['src', 'xfB', 'xfA']);
  });

  it('never drops role-less nodes — they trail the story in input order', () => {
    const order = pipelineRevealOrder([
      N('mystery2'),
      N('src', 'source'),
      N('mystery1'),
    ]).map(n => n.id);
    expect(order).toEqual(['src', 'mystery2', 'mystery1']);
  });

  it('is deterministic across repeated calls', () => {
    const input = [N('a', 'guard'), N('b', 'source'), N('c', 'sink'), N('d', 'transform')];
    expect(pipelineRevealOrder(input).map(n => n.id))
      .toEqual(pipelineRevealOrder(input).map(n => n.id));
  });

  it('recognizes pipeline/data-flow requests, not arbitrary ones', () => {
    expect(isPipelineRequest('show me the data flow')).toBe(true);
    expect(isPipelineRequest('the pipeline')).toBe(true);
    expect(isPipelineRequest('walk me through it')).toBe(true);
    expect(isPipelineRequest('what does the auth module do')).toBe(false);
    expect(isPipelineRequest('')).toBe(false);
    expect(isPipelineRequest(null)).toBe(false);
  });
});

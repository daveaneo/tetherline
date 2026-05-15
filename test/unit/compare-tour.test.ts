import { describe, it, expect } from 'vitest';
import {
  classifyAxis,
  compareTourPlan,
} from '../../packages/backend/src/skills/compare-tour.js';

describe('compare axis classification', () => {
  it('explicit axis param always wins', () => {
    expect(classifyAxis({ axis: 'temporal' }, 'core vs colab')).toBe('temporal');
    expect(classifyAxis({ axis: 'vs-external' }, 'anything')).toBe('vs-external');
  });

  it('detects vs-external from a framework name', () => {
    expect(classifyAxis({}, 'how does this differ from Django')).toBe('vs-external');
  });

  it('detects temporal from change words', () => {
    expect(classifyAxis({}, 'how did the parser change since last week')).toBe('temporal');
  });

  it('defaults to structural (two entities, now)', () => {
    expect(classifyAxis({}, 'core vs colab')).toBe('structural');
  });
});

describe('compare v1 tour plan (existing transitions only)', () => {
  it('structural with two subjects: show A (DESCEND) → B (LATERAL) → synthesis (ASCEND)', () => {
    const tour = compareTourPlan('core', 'colab', 'structural');
    expect(tour.map(s => [s.subject, s.transition, s.beat])).toEqual([
      ['core', 'DESCEND', 'show'],
      ['colab', 'LATERAL', 'contrast'],
      ['core vs colab', 'ASCEND', 'synthesis'],
    ]);
  });

  it('A→B is LATERAL — never a faked spatial zoom between unrelated branches', () => {
    const tour = compareTourPlan('a', 'b', 'structural');
    expect(tour[1].transition).toBe('LATERAL');
  });

  it('temporal / vs-external: single subject, IN_PLACE, no second visual in v1', () => {
    for (const axis of ['temporal', 'vs-external'] as const) {
      const tour = compareTourPlan('parser', undefined, axis);
      expect(tour).toEqual([{ subject: 'parser', transition: 'IN_PLACE', beat: 'synthesis' }]);
    }
  });

  it('structural with no B falls back to single IN_PLACE (no half tour)', () => {
    expect(compareTourPlan('core', undefined, 'structural')).toEqual([
      { subject: 'core', transition: 'IN_PLACE', beat: 'synthesis' },
    ]);
  });
});

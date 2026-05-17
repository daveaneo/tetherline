import { describe, it, expect } from 'vitest';
import {
  levelOrdinal,
  levelHeatStep,
  nextLevelTrigger,
  projectKnowledgeScore,
  applyComprehension,
  taught,
  tested,
  testedTier,
  layerKnowledge,
  rollUp,
  containsAdjacency,
  LISTEN_W,
  TEST_W,
  LEVEL_LABEL,
  LEVEL_REACHED_BY,
  COMPREHENSION_ORDER,
} from '@tetherline/shared';

describe('comprehension model — single source of truth', () => {
  it('levelOrdinal spans 0..5 in spec order; unknown/undefined → 0', () => {
    expect(levelOrdinal('unknown')).toBe(0);
    expect(levelOrdinal('mentioned')).toBe(1);
    expect(levelOrdinal('heard')).toBe(2);
    expect(levelOrdinal('engaged')).toBe(3);
    expect(levelOrdinal('explained')).toBe(4);
    expect(levelOrdinal('confirmed')).toBe(5);
    expect(levelOrdinal(undefined)).toBe(0);
    expect(levelOrdinal(null)).toBe(0);
  });

  it('levelHeatStep matches the ordinal (6 rungs ↔ 6 --heat steps)', () => {
    for (const lvl of COMPREHENSION_ORDER) {
      expect(levelHeatStep(lvl)).toBe(levelOrdinal(lvl));
    }
  });

  it('LEVEL_LABEL / LEVEL_REACHED_BY cover all 6 rungs, non-empty', () => {
    for (const lvl of COMPREHENSION_ORDER) {
      expect(LEVEL_LABEL[lvl]).toBeTruthy();
      expect(LEVEL_REACHED_BY[lvl]).toBeTruthy();
    }
    expect(LEVEL_LABEL.unknown).toBe('not yet');
  });

  it('nextLevelTrigger names the NEXT rung; null at terminal confirmed', () => {
    expect(nextLevelTrigger('unknown')).toBe(LEVEL_REACHED_BY.mentioned);
    expect(nextLevelTrigger('heard')).toBe(LEVEL_REACHED_BY.engaged);
    expect(nextLevelTrigger('explained')).toBe(LEVEL_REACHED_BY.confirmed);
    expect(nextLevelTrigger('confirmed')).toBeNull();
  });

  describe('projectKnowledgeScore — "% of everything"', () => {
    it('empty → all zero, never NaN', () => {
      expect(projectKnowledgeScore([])).toEqual({ score: 0, grillCoverage: 0, counted: 0 });
    });

    it('all confirmed → 100', () => {
      const items = Array.from({ length: 4 }, () => ({ level: 'confirmed' as const }));
      expect(projectKnowledgeScore(items).score).toBe(100);
    });

    it('untouched nodes drag the score down (counted in denominator)', () => {
      // 12 nodes, 3 confirmed (weight 1), 9 unknown (weight 0)
      const items = [
        ...Array.from({ length: 3 }, () => ({ level: 'confirmed' as const })),
        ...Array.from({ length: 9 }, () => ({ level: 'unknown' as const })),
      ];
      // (3 * 1.0) / 12 = 25%
      expect(projectKnowledgeScore(items)).toMatchObject({ score: 25, counted: 12 });
    });

    it('mixed levels → exact weighted average', () => {
      // ords: 5,4,2,0 → weights 1, .8, .4, 0 → sum 2.2 / 4 = 55%
      const items = [
        { level: 'confirmed' as const },
        { level: 'explained' as const },
        { level: 'heard' as const },
        { level: 'unknown' as const },
      ];
      expect(projectKnowledgeScore(items).score).toBe(55);
    });

    it('grillCoverage is independent of score', () => {
      // all explained (score 80) but only half grilled (coverage 50)
      const items = [
        { level: 'explained' as const, grilled: true },
        { level: 'explained' as const, grilled: true },
        { level: 'explained' as const },
        { level: 'explained' as const },
      ];
      const r = projectKnowledgeScore(items);
      expect(r.score).toBe(80);
      expect(r.grillCoverage).toBe(50);
    });
  });

  describe('v2 two-component scoring', () => {
    it('taught is presentation-only (>= heard), no verbal confirmation', () => {
      expect(taught({ level: 'unknown' })).toBe(0);
      expect(taught({ level: 'mentioned' })).toBe(0); // below heard
      expect(taught({ level: 'heard' })).toBe(1);
      expect(taught({ level: 'confirmed' })).toBe(1);
    });

    it('tested = best of regular vs grill ratio, monotonic', () => {
      expect(tested({})).toBe(0);
      expect(tested({ quizCorrect: 2, quizTotal: 3 })).toBeCloseTo(2 / 3);
      expect(tested({ grillStrong: 4, grillAsked: 5 })).toBe(0.8);
      // best of the two
      expect(tested({ quizCorrect: 1, quizTotal: 3, grillStrong: 4, grillAsked: 5 })).toBe(0.8);
    });

    it('testedTier prefers grill, then regular, else none', () => {
      expect(testedTier({})).toBe('none');
      expect(testedTier({ quizTotal: 3 })).toBe('regular');
      expect(testedTier({ grillAsked: 4 })).toBe('grill');
      expect(testedTier({ grilled: true })).toBe('grill');
    });

    it('layerKnowledge blends taught (0.25) + tested (0.75)', () => {
      expect(LISTEN_W).toBe(0.25);
      expect(TEST_W).toBe(0.75);
      expect(layerKnowledge({ level: 'unknown' })).toBe(0);
      expect(layerKnowledge({ level: 'heard' })).toBe(25); // shown, untested
      expect(layerKnowledge({ level: 'heard', quizCorrect: 3, quizTotal: 3 })).toBe(100);
      expect(layerKnowledge({ level: 'heard', grillStrong: 4, grillAsked: 5 })).toBe(85);
    });

    it('rollUp: leaf has no deep; parent deep = mean of children combined', () => {
      const byId = new Map<string, any>([
        ['project', { level: 'heard' }],                               // layer 25
        ['module/core', { level: 'heard', quizCorrect: 3, quizTotal: 3 }], // leaf, layer 100
        ['module/voice', { level: 'unknown' }],                        // leaf, layer 0
      ]);
      const childrenOf = containsAdjacency([
        { from: 'project', to: 'module/core', kind: 'contains' },
        { from: 'project', to: 'module/voice', kind: 'contains' },
        { from: 'module/core', to: 'module/voice', kind: 'imports' }, // ignored
      ]);
      const r = rollUp(byId, childrenOf);
      expect(r.get('module/core')!.deep).toBeNull();
      expect(r.get('module/core')!.combined).toBe(100);
      expect(r.get('module/voice')!.combined).toBe(0);
      // project deep = mean(100, 0) = 50; combined = mean(layer 25, deep 50) = 38
      expect(r.get('project')!.deep).toBe(50);
      expect(r.get('project')!.layer).toBe(25);
      expect(r.get('project')!.combined).toBe(38);
    });

    it('rollUp is cycle-guarded', () => {
      const byId = new Map<string, any>([['a', { level: 'heard' }], ['b', { level: 'heard' }]]);
      const childrenOf = new Map<string, string[]>([['a', ['b']], ['b', ['a']]]);
      expect(() => rollUp(byId, childrenOf)).not.toThrow();
    });
  });

  describe('applyComprehension — read-time overlay', () => {
    it('overwrites stale level/grilled, keyed by briefingId then id', () => {
      const nodes = [
        { id: 'module/core', briefingId: 'module/core', level: 'unknown' as const },
        { id: 'project', level: 'unknown' as const },
        { id: 'module/voice', briefingId: 'module/voice', level: 'heard' as const },
      ];
      const items = [
        { itemId: 'module/core', level: 'confirmed' as const, grilled: true },
        { itemId: 'project', level: 'explained' as const },
      ];
      const out = applyComprehension(nodes, items);
      expect(out[0]).toMatchObject({ level: 'confirmed', grilled: true });
      expect(out[1]).toMatchObject({ level: 'explained', grilled: false });
      // no item → node untouched (still its original level)
      expect(out[2].level).toBe('heard');
    });

    it('returns clones — never mutates the cached node objects', () => {
      const node = { id: 'project', level: 'unknown' as const };
      const out = applyComprehension([node], [{ itemId: 'project', level: 'confirmed' }]);
      expect(out[0]).not.toBe(node);
      expect(node.level).toBe('unknown');
    });
  });
});

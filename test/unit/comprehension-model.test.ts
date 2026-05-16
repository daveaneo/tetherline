import { describe, it, expect } from 'vitest';
import {
  levelOrdinal,
  levelHeatStep,
  nextLevelTrigger,
  projectKnowledgeScore,
  applyComprehension,
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

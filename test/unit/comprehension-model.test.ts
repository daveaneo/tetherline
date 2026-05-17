import { describe, it, expect } from 'vitest';
import {
  levelOrdinal,
  levelHeatStep,
  nextLevelTrigger,
  applyComprehension,
  tested,
  testedTier,
  containsAdjacency,
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

  describe('active-recall ratio helpers', () => {
    it('tested = best of regular vs grill ratio', () => {
      expect(tested({})).toBe(0);
      expect(tested({ quizCorrect: 2, quizTotal: 3 })).toBeCloseTo(2 / 3);
      expect(tested({ grillStrong: 4, grillAsked: 5 })).toBe(0.8);
      expect(tested({ quizCorrect: 1, quizTotal: 3, grillStrong: 4, grillAsked: 5 })).toBe(0.8);
    });

    it('testedTier prefers grill, then regular, else none', () => {
      expect(testedTier({})).toBe('none');
      expect(testedTier({ quizTotal: 3 })).toBe('regular');
      expect(testedTier({ grillAsked: 4 })).toBe('grill');
      expect(testedTier({ grilled: true })).toBe('grill');
    });
  });

  describe('v3 knowledgeRollUp — Seen coverage + tested summary', () => {
    it('Seen% = seen briefings / total over node ∪ descendants (slide-weighted), title counts its own node', async () => {
      const { knowledgeRollUp, containsAdjacency } = await import('@tetherline/shared');
      const byId = new Map<string, any>([
        ['project', { seen: true }],                 // overview watched
        ['module/core', { seen: true, quizCorrect: 3, quizTotal: 3, grilled: true }],
        ['module/frontend', { seen: true, quizCorrect: 2, quizTotal: 3 }],
        ['module/shared', { seen: false }],          // never played
        ['module/voice', { seen: false }],
      ]);
      const adj = containsAdjacency([
        { from: 'project', to: 'module/core', kind: 'contains' },
        { from: 'project', to: 'module/frontend', kind: 'contains' },
        { from: 'project', to: 'module/shared', kind: 'contains' },
        { from: 'project', to: 'module/voice', kind: 'contains' },
      ]);
      const r = knowledgeRollUp(byId, adj);
      // project subtree = 5 nodes, 3 seen (project, core, frontend) → 60%
      expect(r.get('project')!).toMatchObject({ seenCount: 3, total: 5, seenPct: 60 });
      // a leaf component = just itself
      expect(r.get('module/core')!).toMatchObject({ seenCount: 1, total: 1, seenPct: 100 });
      expect(r.get('module/shared')!.seenPct).toBe(0);
    });

    it('tested: component = subtree avg-of-best; title = OWN best (null → —)', async () => {
      const { knowledgeRollUp, containsAdjacency } = await import('@tetherline/shared');
      const byId = new Map<string, any>([
        ['project', { seen: true }], // overview itself never quizzed
        ['module/core', { seen: true, grillStrong: 4, grillAsked: 5, grilled: true }], // best 80
        ['module/frontend', { seen: true, quizCorrect: 2, quizTotal: 3 }], // best 67
      ]);
      const adj = containsAdjacency([
        { from: 'project', to: 'module/core', kind: 'contains' },
        { from: 'project', to: 'module/frontend', kind: 'contains' },
      ]);
      const r = knowledgeRollUp(byId, adj);
      // title: own best = null (overview never tested) → "—"
      expect(r.get('project')!.ownBest).toBeNull();
      // title component-summary = avg(0 project, 80 core, 67 frontend) = 49
      expect(r.get('project')!.testedSummary).toBe(49);
      // a component shows its own subtree summary (leaf → its own best)
      expect(r.get('module/core')!.ownBest).toBe(80);
      expect(r.get('module/core')!.testedSummary).toBe(80);
    });

    it('cycle-guarded', async () => {
      const { knowledgeRollUp } = await import('@tetherline/shared');
      const byId = new Map<string, any>([['a', { seen: true }], ['b', { seen: false }]]);
      const adj = new Map<string, string[]>([['a', ['b']], ['b', ['a']]]);
      expect(() => knowledgeRollUp(byId, adj)).not.toThrow();
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

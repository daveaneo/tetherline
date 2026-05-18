import { describe, it, expect } from 'vitest';
import { critiqueSkill } from '../../packages/backend/src/skills/critique.js';

function ctx(analyzer: unknown) {
  return {
    repoPath: '/r',
    currentArea: { name: 'Core' },
    zoomLevel: 0,
    fileTree: [],
    areas: [],
    analyzer,
  } as never;
}

describe('critique skill — ranked concern list', () => {
  it('returns concerns sorted by severity, narration = the top one', async () => {
    const analyzer = {
      structuredCallDirect: async () => ({
        concerns: [
          { title: 'minor nit', severity: 'low', targets: ['Shared'], detail: 'low detail' },
          { title: 'real risk', severity: 'high', targets: ['Voice'], detail: 'high detail' },
          { title: 'middle', severity: 'medium', targets: ['Core'], detail: 'mid detail' },
        ],
      }),
      answerQuestion: async () => 'SHOULD NOT BE CALLED',
    };
    const r = await critiqueSkill.execute(ctx(analyzer), {});
    const concerns = r.visualPayload.concerns as Array<{ severity: string }>;
    expect(concerns.map(c => c.severity)).toEqual(['high', 'medium', 'low']);
    expect(r.narration).toBe('high detail');
    expect(r.visualPayload.activeIndex).toBe(0);
  });

  it('drops malformed concerns and caps at 5', async () => {
    const analyzer = {
      structuredCallDirect: async () => ({
        concerns: [
          { title: 'a', severity: 'high', detail: 'd1' },
          { title: '', severity: 'high', detail: 'blank title dropped' },
          { title: 'b', severity: 'low', detail: '' },
          { title: 'c', severity: 'high', detail: 'd3' },
          { title: 'd', severity: 'medium', detail: 'd4' },
          { title: 'e', severity: 'high', detail: 'd5' },
          { title: 'f', severity: 'high', detail: 'd6' },
        ],
      }),
      answerQuestion: async () => 'fallback',
    };
    const r = await critiqueSkill.execute(ctx(analyzer), {});
    const concerns = r.visualPayload.concerns as unknown[];
    expect(concerns.length).toBe(5);
  });

  it('falls back to plain prose when the structured call fails (voice north-star)', async () => {
    const analyzer = {
      structuredCallDirect: async () => { throw new Error('LLM no toolInput'); },
      answerQuestion: async () => 'a single honest paragraph',
    };
    const r = await critiqueSkill.execute(ctx(analyzer), {});
    expect(r.skillName).toBe('critique');
    expect(r.narration).toBe('a single honest paragraph');
    expect(r.visualPayload.concerns).toBeUndefined();
  });

  it('falls back when the structured call returns zero usable concerns', async () => {
    const analyzer = {
      structuredCallDirect: async () => ({ concerns: [] }),
      answerQuestion: async () => 'prose fallback',
    };
    const r = await critiqueSkill.execute(ctx(analyzer), {});
    expect(r.narration).toBe('prose fallback');
    expect(r.visualPayload.concerns).toBeUndefined();
  });
});

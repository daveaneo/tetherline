import { describe, it, expect } from 'vitest';
import { TourPlan } from '../../packages/backend/src/session/tour-plan.js';
import {
  interBeatDelayMs,
  DEFAULT_INTER_BEAT_MS,
} from '../../packages/backend/src/session/guided-pacing.js';

describe('TourPlan.fromArchitecture — the second spine builder', () => {
  const arch = {
    projectName: 'Tetherline',
    modules: [
      { id: 'm/core', name: 'Core', files: ['a.ts', 'b.ts'] },
      { id: 'm/ui', name: 'UI' },
    ],
  };

  it('walks TOP-DOWN: project root → module → its files → next module', () => {
    const plan = TourPlan.fromArchitecture(arch);
    expect(plan.items.map(i => [i.type, i.name])).toEqual([
      ['project', 'Tetherline'],
      ['architecture', 'Core'],
      ['file', 'a.ts'],
      ['file', 'b.ts'],
      ['architecture', 'UI'],
    ]);
  });

  it('root is first and parents files under their module', () => {
    const plan = TourPlan.fromArchitecture(arch);
    expect(plan.items[0].id).toBe('project-root');
    const aFile = plan.items.find(i => i.name === 'a.ts')!;
    expect(aFile.parentId).toBe('arch-m/core');
  });

  it('reuses the SAME deviation stack — barge-in unchanged', () => {
    const plan = TourPlan.fromArchitecture(arch);
    expect(plan.isInDeviation()).toBe(false);
    plan.pushDeviation('QA');
    expect(plan.isInDeviation()).toBe(true);
    plan.popDeviation();
    expect(plan.isInDeviation()).toBe(false);
  });

  it('is deterministic', () => {
    expect(TourPlan.fromArchitecture(arch).items).toEqual(
      TourPlan.fromArchitecture(arch).items,
    );
  });
});

describe('guided-learning inter-beat pacing', () => {
  it('lean-back default is the ~5s movie pause', () => {
    expect(interBeatDelayMs({ inDeviation: false })).toBe(DEFAULT_INTER_BEAT_MS);
  });

  it('a barged-in (leaning-in) user never waits — responsiveness wins', () => {
    expect(interBeatDelayMs({ inDeviation: true })).toBe(0);
  });

  it('reduced motion is snappier but still paced (not zero, not full)', () => {
    const d = interBeatDelayMs({ inDeviation: false, reducedMotion: true });
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(DEFAULT_INTER_BEAT_MS);
  });

  it('explicit override wins and clamps non-negative', () => {
    expect(interBeatDelayMs({ inDeviation: false, overrideMs: 1000 })).toBe(1000);
    expect(interBeatDelayMs({ inDeviation: true, overrideMs: -50 })).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { changeHeatByNode } from '@tetherline/shared';

describe('changeHeatByNode — whats_changed DRIFT (changed × unreviewed)', () => {
  const entries = [
    // red: changed a lot, never reviewed → the gap (weight 1)
    { filePath: 'core/analyzer.ts', changeIntensity: 12, status: 'red' as const },
    // yellow: changed, but you reviewed it before → going stale (0.5)
    { filePath: 'core/chunker.ts', changeIntensity: 6, status: 'yellow' as const },
    { filePath: 'voice/gate.ts', changeIntensity: 5, status: 'yellow' as const },
    // green: changed BUT you're caught up → not a gap (weight 0)
    { filePath: 'shared/types.ts', changeIntensity: 8, status: 'green' as const },
    // frontend: nothing changed
  ];

  it('drift = statusWeight × changeIntensity, normalised to the hottest node', () => {
    const h = changeHeatByNode(
      ['project', 'module/core', 'module/voice', 'module/shared', 'module/frontend'],
      entries,
    );
    // raw drift: core = 12*1 + 6*0.5 = 15 ; voice = 5*0.5 = 2.5 ;
    //            shared = 8*0 = 0 (green = caught up) ; frontend = 0
    //            project = 15 + 2.5 + 0 = 17.5 → hottest
    expect(h.get('project')).toBe(1);
    expect(h.get('module/core')).toBeCloseTo(15 / 17.5);
    expect(h.get('module/voice')).toBeCloseTo(2.5 / 17.5);
    expect(h.get('module/shared')).toBe(0);   // changed but you're current
    expect(h.get('module/frontend')).toBe(0); // never moved
  });

  it('a green file that DID change still contributes 0 (no longer a gap)', () => {
    const h = changeHeatByNode(['module/shared'], [
      { filePath: 'shared/x.ts', changeIntensity: 99, status: 'green' },
    ]);
    expect(h.get('module/shared')).toBe(0);
  });

  it('missing status ⇒ treated as a gap (weight 1) when it changed', () => {
    const h = changeHeatByNode(['file/a.ts', 'file/b.ts'], [
      { filePath: 'a.ts', changeIntensity: 4 },                       // unknown → 1
      { filePath: 'b.ts', changeIntensity: 2, status: 'yellow' },     // 0.5
    ]);
    expect(h.get('file/a.ts')).toBe(1);          // 4 is the max
    expect(h.get('file/b.ts')).toBeCloseTo(1 / 4); // 2*0.5 = 1
  });

  it('all caught-up / nothing changed → every node cold, never NaN', () => {
    const h = changeHeatByNode(['project', 'module/core'], [
      { filePath: 'core/x.ts', changeIntensity: 0, status: 'red' },
      { filePath: 'core/y.ts', changeIntensity: 9, status: 'green' },
    ]);
    expect(h.get('project')).toBe(0);
    expect(h.get('module/core')).toBe(0);
  });
});

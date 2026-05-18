import { describe, it, expect } from 'vitest';
import { changeHeatByNode } from '@tetherline/shared';

describe('changeHeatByNode — whats_changed per-node heat', () => {
  const entries = [
    { filePath: 'core/analyzer.ts', changeIntensity: 12 },
    { filePath: 'core/chunker.ts', changeIntensity: 6 },
    { filePath: 'voice/gate.ts', changeIntensity: 5 },
    { filePath: 'shared/types.ts', changeIntensity: 1 },
    // frontend has no changed files this window
  ];

  it('module = sum of its files, normalised against the hottest node', () => {
    const h = changeHeatByNode(
      ['project', 'module/core', 'module/voice', 'module/shared', 'module/frontend'],
      entries,
    );
    // raw: project=24, core=18, voice=5, shared=1, frontend=0 → max 24
    expect(h.get('project')).toBe(1);                 // 24/24
    expect(h.get('module/core')).toBeCloseTo(18 / 24); // 0.75
    expect(h.get('module/voice')).toBeCloseTo(5 / 24);
    expect(h.get('module/shared')).toBeCloseTo(1 / 24);
    expect(h.get('module/frontend')).toBe(0);          // untouched → cold
  });

  it('file node takes its own file intensity (by exact or suffix match)', () => {
    const h = changeHeatByNode(['file/core/analyzer.ts', 'file/core/chunker.ts'], entries);
    // max among the two = 12 → analyzer 1, chunker 0.5
    expect(h.get('file/core/analyzer.ts')).toBe(1);
    expect(h.get('file/core/chunker.ts')).toBeCloseTo(0.5);
  });

  it('all-zero entries → every node cold (0), never NaN', () => {
    const h = changeHeatByNode(['project', 'module/core'], [{ filePath: 'core/x.ts', changeIntensity: 0 }]);
    expect(h.get('project')).toBe(0);
    expect(h.get('module/core')).toBe(0);
  });
});

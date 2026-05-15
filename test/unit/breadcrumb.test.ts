import { describe, it, expect } from 'vitest';
import {
  buildBreadcrumb,
  breadcrumbText,
} from '../../packages/frontend/src/components/room/breadcrumb.js';

describe('you-are-here breadcrumb (P0)', () => {
  it('spine only: deepest crumb is the current position', () => {
    const c = buildBreadcrumb({ spine: ['Tetherline', 'Core'] });
    expect(breadcrumbText(c)).toBe('Tetherline ▸ Core');
    expect(c[1].current).toBe(true);
    expect(c[0].current).toBe(false);
  });

  it('never empty — falls back to a root crumb', () => {
    const c = buildBreadcrumb({ spine: [] });
    expect(c).toHaveLength(1);
    expect(c[0].label).toBe('Project');
    expect(c[0].current).toBe(true);
  });

  it('inside a pocket: spine is the dimmed return path; slide is live', () => {
    const c = buildBreadcrumb({
      spine: ['Tetherline', 'Core'],
      pocket: { focus: 'token refresh', slide: 2, total: 8 },
    });
    expect(breadcrumbText(c)).toBe('Tetherline ▸ Core ▸ token refresh ▸ 3/8');
    // no spine crumb is "current" while in a pocket
    expect(c.filter(x => x.kind === 'spine').every(x => !x.current)).toBe(true);
    // the slide cursor is the live position
    const slide = c.find(x => x.kind === 'slide')!;
    expect(slide.current).toBe(true);
    expect(slide.label).toBe('3/8');
  });

  it('pocket with no focus still labels the pocket', () => {
    const c = buildBreadcrumb({ spine: ['P'], pocket: { focus: '  ', slide: 0, total: 4 } });
    expect(c.find(x => x.kind === 'pocket')!.label).toBe('deep dive');
    expect(c.find(x => x.kind === 'slide')!.label).toBe('1/4');
  });

  it('slide index never exceeds total in the label', () => {
    const c = buildBreadcrumb({ spine: ['P'], pocket: { focus: 'x', slide: 99, total: 5 } });
    expect(c.find(x => x.kind === 'slide')!.label).toBe('5/5');
  });

  it('is deterministic', () => {
    const i = { spine: ['A', 'B'], pocket: { focus: 'f', slide: 1, total: 3 } };
    expect(buildBreadcrumb(i)).toEqual(buildBreadcrumb(i));
  });
});

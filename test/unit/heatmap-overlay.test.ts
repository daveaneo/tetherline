import { describe, it, expect } from 'vitest';
import { heatmapOverlayActive } from '../../packages/frontend/src/components/room/heatmap-overlay.js';

// Strict: the overlay must activate ONLY for whats_changed at project
// scope, and the predicate must be pure (no side effects) so the
// "overlay never clears the layout" invariant holds structurally.

describe('heatmapOverlayActive', () => {
  it('activates for whats_changed at project scope', () => {
    expect(heatmapOverlayActive({ skillName: 'whats_changed' }, 'project')).toBe(true);
    expect(heatmapOverlayActive({ skillName: 'whats_changed' }, null)).toBe(true);
    expect(heatmapOverlayActive({ skillName: 'whats_changed' }, undefined)).toBe(true);
  });

  it('does NOT activate at a drilled (non-project) scope', () => {
    expect(heatmapOverlayActive({ skillName: 'whats_changed' }, 'module/core')).toBe(false);
    expect(heatmapOverlayActive({ skillName: 'whats_changed' }, 'file/core/loader.py')).toBe(false);
  });

  it('does NOT activate for any other skill', () => {
    for (const s of ['explain', 'visualize', 'critique', 'navigate', 'grill_me', 'compare']) {
      expect(heatmapOverlayActive({ skillName: s }, 'project')).toBe(false);
    }
  });

  it('does NOT activate with no skill result', () => {
    expect(heatmapOverlayActive(null, 'project')).toBe(false);
    expect(heatmapOverlayActive(undefined, 'project')).toBe(false);
    expect(heatmapOverlayActive({}, 'project')).toBe(false);
  });
});

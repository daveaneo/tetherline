import { describe, it, expect } from 'vitest';
import { dispatchVisual } from '../../packages/backend/src/intelligence/visual-dispatcher.js';

// Strict: each case asserts the EXACT transition + resolved id. A
// misclassification (the bug this guards) must fail the test, not be
// tolerated.

const NODES = ['module/core', 'module/colab', 'file/core/loader.py', 'file/core/runner.py'];
const LABELS: Record<string, string> = {
  'module/core': 'Core',
  'module/colab': 'Colab',
  'file/core/loader.py': 'loader.py',
  'file/core/runner.py': 'runner.py',
};

describe('visual-dispatcher relationship grammar', () => {
  it('IN_PLACE when target resolves to the current scope', () => {
    const r = dispatchVisual({
      target: 'core',
      currentScope: 'module/core',
      knownNodeIds: NODES,
      nodeLabels: LABELS,
    });
    expect(r.transition).toBe('IN_PLACE');
    expect(r.targetNodeId).toBe('module/core');
  });

  it('DESCEND when target is a node within the current view', () => {
    const r = dispatchVisual({
      target: 'loader.py',
      currentScope: 'module/core',
      knownNodeIds: NODES,
      nodeLabels: LABELS,
    });
    expect(r.transition).toBe('DESCEND');
    expect(r.targetNodeId).toBe('file/core/loader.py');
  });

  it('ASCEND when target is an ancestor of the current scope', () => {
    const r = dispatchVisual({
      target: 'core',
      currentScope: 'file/core/loader.py',
      knownNodeIds: NODES,
      nodeLabels: LABELS,
      navigatorAncestors: ['module/core'],
    });
    expect(r.transition).toBe('ASCEND');
    expect(r.targetNodeId).toBe('module/core');
  });

  it('LATERAL when target resolves elsewhere, not in the current set', () => {
    const r = dispatchVisual({
      target: 'colab',
      currentScope: 'file/core/loader.py',
      knownNodeIds: ['file/core/loader.py', 'file/core/runner.py'],
      nodeLabels: LABELS,
      navigatorAncestors: ['module/core'],
      globalNodeIds: NODES,
      globalNodeLabels: LABELS,
    });
    expect(r.transition).toBe('LATERAL');
    expect(r.targetNodeId).toBe('module/colab');
  });

  it('GENERATE when target has no node anywhere, with a suggestion', () => {
    const r = dispatchVisual({
      target: 'kubernetes operators',
      currentScope: 'module/core',
      knownNodeIds: NODES,
      nodeLabels: LABELS,
    });
    expect(r.transition).toBe('GENERATE');
    expect(r.targetNodeId).toBeUndefined();
  });

  it('resolution is deterministic and most-specific (no double-drill)', () => {
    // "core" must resolve to module/core (shortest containing id),
    // NEVER file/core/loader.py — the historical double-drill bug.
    const r = dispatchVisual({
      target: 'core',
      currentScope: null,
      knownNodeIds: NODES,
      nodeLabels: LABELS,
    });
    expect(r.targetNodeId).toBe('module/core');
  });

  it('defensive: empty target and empty node set GENERATE without crashing', () => {
    expect(dispatchVisual({ target: '   ', currentScope: null, knownNodeIds: NODES }).transition).toBe('GENERATE');
    expect(dispatchVisual({ target: 'anything', currentScope: null, knownNodeIds: [] }).transition).toBe('GENERATE');
  });

  it('ASCEND wins over LATERAL when the elsewhere node is an ancestor', () => {
    const r = dispatchVisual({
      target: 'core',
      currentScope: 'file/core/runner.py',
      knownNodeIds: ['file/core/runner.py'],
      navigatorAncestors: ['module/core'],
      globalNodeIds: NODES,
      globalNodeLabels: LABELS,
    });
    expect(r.transition).toBe('ASCEND');
    expect(r.targetNodeId).toBe('module/core');
  });
});

import { describe, it, expect } from 'vitest';
import {
  validateDiagramGraph,
  DIAGRAM_TOOL,
} from '../../packages/backend/src/intelligence/prompts/diagram-tool.js';

describe('DIAGRAM_TOOL schema', () => {
  it('requires intent BEFORE the graph (think-then-commit)', () => {
    expect(DIAGRAM_TOOL.inputSchema.required).toEqual(['intent', 'layout', 'nodes']);
    expect(DIAGRAM_TOOL.inputSchema.properties.layout.enum).toEqual([
      'radial', 'flow', 'sequence', 'deps',
    ]);
  });
});

describe('validateDiagramGraph — never trust raw LLM output', () => {
  it('accepts a well-formed graph', () => {
    const r = validateDiagramGraph({
      intent: 'how auth flows',
      layout: 'flow',
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      edges: [{ source: 'a', target: 'b' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.nodes).toHaveLength(2);
      expect(r.graph.edges).toEqual([{ source: 'a', target: 'b', label: undefined }]);
      expect(r.dropped).toEqual([]);
    }
  });

  it('rejects missing intent (the think-then-commit guard)', () => {
    const r = validateDiagramGraph({ layout: 'flow', nodes: [{ id: 'a', label: 'A' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('missing intent (think-then-commit field)');
  });

  it('rejects an unknown layout (invalid discriminator)', () => {
    const r = validateDiagramGraph({ intent: 'x', layout: 'mindmap', nodes: [{ id: 'a', label: 'A' }] });
    expect(r.ok).toBe(false);
  });

  it('DROPS edges referencing undeclared nodes — cannot hallucinate an edge', () => {
    const r = validateDiagramGraph({
      intent: 'x',
      layout: 'deps',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [{ source: 'a', target: 'ghost' }, { source: 'a', target: 'a' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.edges).toEqual([{ source: 'a', target: 'a', label: undefined }]);
      expect(r.dropped).toEqual(['a→ghost']);
    }
  });

  it('skips blank/duplicate node ids; fails if nothing valid remains', () => {
    const ok = validateDiagramGraph({
      intent: 'x', layout: 'flow',
      nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'dupe' }, { id: '', label: 'blank' }],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.graph.nodes).toEqual([{ id: 'a', label: 'A' }]);

    const bad = validateDiagramGraph({ intent: 'x', layout: 'flow', nodes: [{ id: '', label: 'z' }] });
    expect(bad.ok).toBe(false);
  });

  it('null / garbage input fails cleanly, never throws', () => {
    expect(validateDiagramGraph(null).ok).toBe(false);
    expect(validateDiagramGraph('nope').ok).toBe(false);
    expect(validateDiagramGraph({}).ok).toBe(false);
  });
});

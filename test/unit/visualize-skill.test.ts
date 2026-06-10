import { describe, it, expect } from 'vitest';
import { visualizeSkill } from '../../packages/backend/src/skills/visualize.js';

function ctx(analyzer: unknown) {
  return {
    repoPath: '/r',
    currentArea: { name: 'Core' },
    zoomLevel: 0,
    fileTree: [],
    areas: [{ id: 'a1', name: 'Core', description: 'core stuff' }],
    analyzer,
  } as never;
}

describe('visualize skill — authors a fresh diagram', () => {
  it('returns an authored diagram payload + matching narration', async () => {
    const analyzer = {
      structuredCallDirect: async () => ({
        narration: 'Pipeline: FileLoader feeds the Chunker which feeds the ModelWriter.',
        kind: 'pipeline',
        title: 'PersonalForge flow',
        subtitle: 'Input → transform → output',
        nodes: [
          { id: 'file-loader', label: 'FileLoader', role: 'source' },
          { id: 'chunker', label: 'Chunker', role: 'transform' },
          { id: 'model-writer', label: 'ModelWriter', role: 'sink' },
        ],
        edges: [
          { from: 'file-loader', to: 'chunker' },
          { from: 'chunker', to: 'model-writer' },
        ],
      }),
      answerQuestion: async () => 'SHOULD NOT BE CALLED',
    };
    const r = await visualizeSkill.execute(ctx(analyzer), { target: 'the flow' });
    expect(r.skillName).toBe('visualize');
    expect(r.narration).toMatch(/FileLoader/);
    const diag = (r.visualPayload as { diagram?: { nodes: unknown[]; scope: string; kind?: string } }).diagram;
    expect(diag, 'authored diagram present').toBeTruthy();
    expect(diag!.nodes.length).toBe(3);
    expect(diag!.scope).toMatch(/^authored\//);
    expect((r.visualPayload as { kind?: string }).kind).toBe('pipeline');
  });

  it('drops edges referencing unknown nodes', async () => {
    const analyzer = {
      structuredCallDirect: async () => ({
        narration: 'two nodes one edge',
        kind: 'graph', title: 't', subtitle: 's',
        nodes: [
          { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'b' },              // dup, kept (dedup not in scope)
          { from: 'a', to: 'phantom' },        // dropped — unknown target
          { from: 'a', to: 'a' },              // dropped — self-loop
        ],
      }),
      answerQuestion: async () => 'fallback',
    };
    const r = await visualizeSkill.execute(ctx(analyzer), {});
    const diag = (r.visualPayload as { diagram?: { edges: unknown[] } }).diagram;
    expect(diag!.edges.length).toBe(2);
  });

  it('falls back to plain prose when the authored diagram is too thin (<3 nodes)', async () => {
    const analyzer = {
      structuredCallDirect: async () => ({
        narration: 'meh', kind: 'graph', title: 't', subtitle: 's',
        nodes: [{ id: 'a', label: 'A' }], edges: [],
      }),
      answerQuestion: async () => 'prose fallback',
    };
    const r = await visualizeSkill.execute(ctx(analyzer), {});
    expect(r.narration).toBe('prose fallback');
    expect((r.visualPayload as { diagram?: unknown }).diagram).toBeUndefined();
  });

  it('serves a precompiled flow from cache with ZERO LLM calls', async () => {
    let llmCalls = 0;
    const analyzer = {
      structuredCallDirect: async () => { llmCalls++; return {}; },
      answerQuestion: async () => { llmCalls++; return 'x'; },
    };
    const cacheRepo = {
      getModulesForRepo: () => [{ modulePath: 'core', keyFiles: ['core/a.py'] }],
    };
    const diagramRepo = {
      get: (_r: string, scope: string, view: string) =>
        scope === 'flow/module/core' && view === 'logic'
          ? {
              scope: 'flow/module/core', title: 'Core workflow', subtitle: 's',
              narration: 'Here is the core workflow.',
              nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
              edges: [{ from: 'a', to: 'b' }],
            }
          : null,
    };
    const ctxWithCache = { ...(ctx(analyzer) as any), cacheRepo, diagramRepo } as never;
    const r = await visualizeSkill.execute(ctxWithCache, { target: 'core' });
    expect(llmCalls, 'a cache hit must not call the LLM').toBe(0);
    expect(r.narration).toBe('Here is the core workflow.');
    const diag = (r.visualPayload as { diagram?: { scope: string } }).diagram;
    expect(diag!.scope).toBe('flow/module/core');
  });

  it('falls back to plain prose when the structured call fails (voice north-star)', async () => {
    const analyzer = {
      structuredCallDirect: async () => { throw new Error('LLM blew up'); },
      answerQuestion: async () => 'prose fallback',
    };
    const r = await visualizeSkill.execute(ctx(analyzer), {});
    expect(r.narration).toBe('prose fallback');
    expect((r.visualPayload as { diagram?: unknown }).diagram).toBeUndefined();
  });
});

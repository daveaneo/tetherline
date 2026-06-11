/**
 * Authored-diagram validation: the LLM authors nodes/edges from module
 * summaries (no code), so it guesses. validateFlow grounds the guess against
 * the real files + import graph:
 *   - a node that maps to no real file is demoted to `conceptual` (dotted),
 *   - an edge the import graph doesn't support is dashed `inferred` (or dropped
 *     if neither end is real),
 *   - a degree-0 node is dropped while ≥3 remain,
 *   - narration that names a component with no node (the live FileLoader
 *     mismatch 2026-06-10) flags narrationOk=false so the caller repairs it.
 */
import { describe, it, expect } from 'vitest';
import { validateFlow, normalizeTokens, type FlowEvidence } from '../../packages/backend/src/intelligence/flow-validate.js';

const evidence: FlowEvidence = {
  moduleName: 'core',
  files: ['core/data_cleaner.py', 'core/web_collector.py', 'core/pair_generator.py'],
  importEdges: [
    { from: 'core/web_collector.py', to: 'core/data_cleaner.py' },
    { from: 'core/data_cleaner.py', to: 'core/pair_generator.py' },
  ],
};

describe('normalizeTokens', () => {
  it('bridges snake_case files and CamelCase labels', () => {
    expect([...normalizeTokens('data_cleaner.py')]).toContain('cleaner');
    expect([...normalizeTokens('DataCleaner')]).toContain('cleaner');
    // shared token ⇒ they match.
    const a = normalizeTokens('data_cleaner.py');
    const b = normalizeTokens('DataCleaner');
    expect([...a].some(t => b.has(t))).toBe(true);
  });

  it('resolves Python dotted names to the same tokens as a path', () => {
    const dotted = normalizeTokens('personalforge.collectors.web_collector');
    const pathy = normalizeTokens('collectors/web_collector.py');
    expect([...dotted].some(t => pathy.has(t) && t.length > 3)).toBe(true);
  });
});

describe('validateFlow', () => {
  it('grounds fuzzy-matched nodes to their evidence file', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }],
      narration: 'WebCollector feeds DataCleaner, which builds PairGenerator pairs.',
    }, evidence);
    const dc = r.nodes.find(n => n.id === 'dc')!;
    expect(dc.evidenceFile).toBe('core/data_cleaner.py');
    expect(dc.conceptual).not.toBe(true);
  });

  it('keeps an import-supported edge solid and dashes an unsupported one', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
      ],
      // wc→dc is supported; wc→pg is NOT in the import graph.
      edges: [{ from: 'wc', to: 'dc' }, { from: 'wc', to: 'pg' }],
      narration: 'WebCollector, DataCleaner, PairGenerator.',
    }, evidence);
    const supported = r.edges.find(e => e.from === 'wc' && e.to === 'dc')!;
    const guessed = r.edges.find(e => e.from === 'wc' && e.to === 'pg')!;
    expect(supported.inferred).not.toBe(true);
    expect(guessed.inferred).toBe(true);
  });

  it('drops an edge when neither endpoint grounds to a real file', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
        { id: 'ghost1', label: 'Imaginary Thing' },
        { id: 'ghost2', label: 'Another Phantom' },
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'ghost1', to: 'ghost2' }],
      narration: 'WebCollector, DataCleaner, PairGenerator.',
    }, evidence);
    expect(r.edges.some(e => e.from === 'ghost1' && e.to === 'ghost2')).toBe(false);
  });

  it('demotes an ungrounded node to conceptual rather than deleting it', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
        { id: 'gguf', label: 'GGUF File' }, // a concept, not a file in core/
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }, { from: 'pg', to: 'gguf' }],
      narration: 'WebCollector, DataCleaner, PairGenerator, GGUF File.',
    }, evidence);
    const gguf = r.nodes.find(n => n.id === 'gguf');
    expect(gguf?.conceptual).toBe(true);
  });

  it('drops a degree-0 orphan node while ≥3 nodes remain', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
        { id: 'hw', label: 'HWScanner' }, // floats with no edges
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }],
      narration: 'WebCollector, DataCleaner, PairGenerator.',
    }, evidence);
    expect(r.nodes.some(n => n.id === 'hw')).toBe(false);
    expect(r.dropped).toContain('hw');
    expect(r.nodes.length).toBeGreaterThanOrEqual(3);
  });

  it('flags narration that names a component with no node (the FileLoader bug)', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }],
      // "FileLoader" is spoken but never drawn.
      narration: 'Three sources feed in — FileLoader handles your local documents, then WebCollector and DataCleaner.',
    }, evidence);
    expect(r.narrationOk).toBe(false);
  });

  it('flags an acronym-prefixed component name with no node (GGUFWriter/HFStreamer)', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }],
      narration: 'WebCollector and DataCleaner feed the GGUFWriter that bakes the model file.',
    }, evidence);
    expect(r.narrationOk).toBe(false);
  });

  it('does not flag brand/language names that are not nodes (TypeScript)', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }],
      narration: 'WebCollector, DataCleaner, and PairGenerator, all written in TypeScript.',
    }, evidence);
    expect(r.narrationOk).toBe(true);
  });

  it('assigns module files to their best-match stage; unmatched files go unassigned', () => {
    const ev: FlowEvidence = {
      moduleName: 'core',
      files: ['core/web_collector.py', 'core/data_cleaner.py', 'core/data_validator.py', 'core/hardware_scanner.py'],
      importEdges: [{ from: 'core/web_collector.py', to: 'core/data_cleaner.py' }],
    };
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }],
      narration: 'WebCollector, DataCleaner, PairGenerator.',
    }, ev);
    const dc = r.nodes.find(n => n.id === 'dc')!;
    // data_cleaner.py AND data_validator.py share the "data" token → both land on DataCleaner.
    expect(dc.implementsFiles).toContain('core/data_cleaner.py');
    expect(dc.implementsFiles).toContain('core/data_validator.py');
    // hardware_scanner.py matches no stage → surfaced as "not shown".
    expect(r.unassignedFiles).toContain('core/hardware_scanner.py');
  });

  it('drops a self-referential module node ("Core Module") when real stages remain', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
        { id: 'self', label: 'Core Module' },
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }, { from: 'self', to: 'wc' }],
      narration: 'WebCollector, DataCleaner, PairGenerator.',
    }, evidence);
    expect(r.nodes.some(n => n.id === 'self'), 'the module-as-its-own-node is dropped').toBe(false);
    expect(r.nodes.length).toBeGreaterThanOrEqual(3);
  });

  it('passes narration that only names real nodes', () => {
    const r = validateFlow({
      nodes: [
        { id: 'wc', label: 'WebCollector' },
        { id: 'dc', label: 'DataCleaner' },
        { id: 'pg', label: 'PairGenerator' },
      ],
      edges: [{ from: 'wc', to: 'dc' }, { from: 'dc', to: 'pg' }],
      narration: 'WebCollector feeds DataCleaner, which produces the PairGenerator output.',
    }, evidence);
    expect(r.narrationOk).toBe(true);
  });
});

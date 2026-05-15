import { describe, it, expect } from 'vitest';
import {
  buildExportModel,
  renderMarkdown,
  renderSite,
  exportAs,
  shareExplanation,
  NotImplementedError,
  RouteDelegatedError,
  type ExportSection,
} from '../../packages/backend/src/export/export-model.js';

const SECS: ExportSection[] = [
  { title: 'Auth', prose: 'auth does X', files: ['auth.ts'], svg: '<svg id="a"/>' },
  { title: 'Billing', prose: 'billing does Y', files: [] },
];

describe('export model — scope solved upstream', () => {
  it('whole project = all sections', () => {
    expect(buildExportModel('P', SECS).sections).toHaveLength(2);
  });
  it('named subsection filters sections (renderers stay scope-agnostic)', () => {
    const m = buildExportModel('P', SECS, 'auth');
    expect(m.sections.map(s => s.title)).toEqual(['Auth']);
  });
  it('unknown subsection → empty, never throws', () => {
    expect(buildExportModel('P', SECS, 'nope').sections).toEqual([]);
  });
});

describe('renderers (pure, deterministic)', () => {
  it('markdown has project + section headings + files', () => {
    const md = renderMarkdown(buildExportModel('Proj', SECS));
    expect(md).toContain('# Proj');
    expect(md).toContain('## Auth');
    expect(md).toContain('- `auth.ts`');
    expect(renderMarkdown(buildExportModel('Proj', SECS))).toBe(md); // deterministic
  });
  it('site is a navigable multi-section shell, escapes HTML, embeds svg', () => {
    const html = renderSite(buildExportModel('P', [{ title: 'A<b>', prose: 'p&q', files: [], svg: '<svg/>' }]));
    expect(html).toContain('<nav>');
    expect(html).toContain('A&lt;b&gt;'); // escaped
    expect(html).toContain('p&amp;q');
    expect(html).toContain('<svg/>'); // svg embedded
  });
});

describe('format dispatcher — honest about what is real', () => {
  const m = buildExportModel('P', SECS);
  it('markdown + site render', () => {
    expect(typeof exportAs('markdown', m)).toBe('string');
    expect(typeof exportAs('site', m)).toBe('string');
  });
  it('pdf + video throw NotImplementedError (never fake success)', () => {
    expect(() => exportAs('pdf', m)).toThrow(NotImplementedError);
    expect(() => exportAs('video', m)).toThrow(NotImplementedError);
  });
  it('slides is DELEGATED, not "not implemented" (it works via the route)', () => {
    expect(() => exportAs('slides', m)).toThrow(RouteDelegatedError);
    expect(() => exportAs('slides', m)).not.toThrow(NotImplementedError);
  });
});

describe('share_explanation folds in as the smallest cell', () => {
  it('one area → markdown (no separate skill)', () => {
    const out = shareExplanation(SECS[0], 'P');
    expect(out).toContain('## Auth');
    expect(out).not.toContain('## Billing');
  });
});

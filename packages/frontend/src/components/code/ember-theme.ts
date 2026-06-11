/**
 * "Ember" — a shiki theme derived from the app's espresso/cream/amber
 * tokens. Shiki themes need concrete colors (they render to inline
 * styles, CSS vars don't reach them), so these are hex approximations
 * of the oklch tokens in styles/global.css:
 *   bg      ≈ --ink-050      fg      ≈ --cream-800
 *   keyword ≈ --amber-400    string  ≈ --amber-200-ish warm sand
 *   comment ≈ --cream-400    accent  ≈ --amber-500
 * Replaces github-dark-default, whose cool blue-slate palette was the
 * single most jarring token violation inside the warm skin.
 */
import type { ThemeRegistration } from 'shiki/core';

export const emberTheme: ThemeRegistration = {
  name: 'ember',
  displayName: 'Ember',
  type: 'dark',
  colors: {
    'editor.background': '#251c15',
    'editor.foreground': '#e9ddcd',
    'editorLineNumber.foreground': '#79695a',
  },
  settings: [
    { settings: { background: '#251c15', foreground: '#e9ddcd' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#8a7a69', fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted', 'punctuation.definition.string'], settings: { foreground: '#d9b98a' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: '#de9457' } },
    { scope: ['keyword', 'storage.type', 'storage.modifier'], settings: { foreground: '#e8a763' } },
    { scope: ['keyword.operator', 'punctuation'], settings: { foreground: '#b3a08c' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: '#f3e7d3' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#cdb392' } },
    { scope: ['variable', 'variable.parameter', 'meta.definition.variable'], settings: { foreground: '#e9ddcd' } },
    { scope: ['variable.other.property', 'support.variable.property'], settings: { foreground: '#dcc9ae' } },
    { scope: ['entity.name.tag'], settings: { foreground: '#e8a763' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#cdb392' } },
    { scope: ['markup.inserted'], settings: { foreground: '#a4b58a' } },
    { scope: ['markup.deleted'], settings: { foreground: '#d97f66' } },
    { scope: ['markup.heading', 'markup.bold'], settings: { foreground: '#f3e7d3', fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
  ],
};

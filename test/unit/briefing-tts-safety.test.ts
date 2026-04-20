import { describe, it, expect } from 'vitest';
import { validateTTSText, stripMarkdownForSpeech } from '../../packages/backend/src/briefing/tts-safety.js';

describe('validateTTSText', () => {
  it('passes well-formed prose', () => {
    const r = validateTTSText('Tetherline is a local-first tool that keeps you tethered to a codebase moving faster than you can absorb. It stays out of your way until you ask it something.');
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('flags markdown headings', () => {
    const r = validateTTSText('# Heading\nSome body text that is reasonably long for a briefing.');
    expect(r.ok).toBe(false);
    expect(r.issues.map(i => i.kind)).toContain('markdown_heading');
  });

  it('flags bullet lists', () => {
    const r = validateTTSText('The app does three things.\n- First thing\n- Second thing\n- Third thing');
    expect(r.ok).toBe(false);
    expect(r.issues.map(i => i.kind)).toContain('bullet_list');
  });

  it('flags numbered lists', () => {
    const r = validateTTSText('The app does three things.\n1. First\n2. Second\n3. Third');
    expect(r.ok).toBe(false);
    expect(r.issues.map(i => i.kind)).toContain('numbered_list');
  });

  it('flags code fences and backticks', () => {
    const r1 = validateTTSText('Call it like this:\n```ts\nfoo()\n```\nThat is the pattern used throughout.');
    expect(r1.issues.map(i => i.kind)).toContain('code_fence');
    const r2 = validateTTSText('Use the `capture()` function when you need idempotency. It runs the gateway under the hood.');
    expect(r2.issues.map(i => i.kind)).toContain('inline_backticks');
  });

  it('flags bare URLs', () => {
    const r = validateTTSText('Docs live at https://example.com/docs and the readme covers setup and configuration.');
    expect(r.issues.map(i => i.kind)).toContain('url_in_prose');
  });

  it('flags too-short text', () => {
    const r = validateTTSText('Very short.');
    expect(r.issues.map(i => i.kind)).toContain('too_short');
  });

  it('estimates spoken duration from word count', () => {
    const text = Array.from({ length: 50 }, () => 'word').join(' ');
    const r = validateTTSText(text);
    expect(r.wordCount).toBe(50);
    // 50 words / 2.5 wps = 20s
    expect(r.estimatedSeconds).toBe(20);
  });
});

describe('stripMarkdownForSpeech', () => {
  it('removes bullet markers and heading syntax', () => {
    const out = stripMarkdownForSpeech('# Title\n- one\n- two\n- three');
    expect(out).not.toMatch(/^#/);
    expect(out).not.toMatch(/^-\s/m);
  });

  it('unwraps bold and italic', () => {
    expect(stripMarkdownForSpeech('This is **bold** and *italic*.')).toBe('This is bold and italic.');
  });

  it('strips inline backticks', () => {
    expect(stripMarkdownForSpeech('Call the `foo()` method directly.')).toBe('Call the foo() method directly.');
  });

  it('removes code fences entirely', () => {
    const out = stripMarkdownForSpeech('Setup is easy.\n```\nnpm install\n```\nThen run it.');
    expect(out).not.toMatch(/```/);
  });

  it('unwraps markdown links to plain text', () => {
    expect(stripMarkdownForSpeech('See the [docs](https://example.com/docs) for details.')).toBe('See the docs for details.');
  });
});

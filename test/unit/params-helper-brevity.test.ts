import { describe, it, expect } from 'vitest';
import { constraintInstruction } from '../../packages/backend/src/skills/params-helper.js';

const BREVITY = 'Default to 2-3 conversational sentences.';

describe('constraintInstruction — brevity survival', () => {
  it('returns the default brevity when no params', () => {
    expect(constraintInstruction({}, [], BREVITY)).toBe(BREVITY);
  });

  it('keeps the default brevity alongside NON-length params', () => {
    // The personalforge regression: {topic, context} evicted "2-3
    // sentences" and the answer ran ~90 seconds.
    const out = constraintInstruction({ topic: 'installation steps', context: 'personal' }, [], BREVITY);
    expect(out).toContain('topic: installation steps');
    expect(out).toContain(BREVITY);
  });

  it('lets an explicit length constraint replace the default', () => {
    const out = constraintInstruction({ length: '10 words' }, [], BREVITY);
    expect(out).toContain('length: 10 words');
    expect(out).not.toContain(BREVITY);
  });

  it('treats "brief"/"detail" style params as length-ish', () => {
    expect(constraintInstruction({ style: 'brief' }, [], BREVITY)).not.toContain(BREVITY);
    expect(constraintInstruction({ depth: 'lots of detail' }, [], BREVITY)).not.toContain(BREVITY);
  });

  it('still excludes keys inlined elsewhere', () => {
    const out = constraintInstruction({ target: 'capture.ts', topic: 'x' }, ['target'], BREVITY);
    expect(out).not.toContain('capture.ts');
  });
});

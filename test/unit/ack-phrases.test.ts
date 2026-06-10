import { describe, it, expect } from 'vitest';
import { pickAck, ALL_ACK_PHRASES } from '../../packages/backend/src/session/ack-phrases.js';

describe('pickAck', () => {
  it('routes visual asks to the pull-up ack', () => {
    expect(pickAck('show me the auth flow', null)).toBe('Let me pull that up.');
    expect(pickAck('can you draw the pipeline', null)).toBe('Let me pull that up.');
  });

  it('routes questions to a look ack', () => {
    expect(pickAck('what does the loader do', null)).toBe('Let me take a look.');
    expect(pickAck('how is this wired together', null)).toBe('Let me take a look.');
  });

  it('routes change asks to the changes ack', () => {
    expect(pickAck('compare this to last week', null)).toBe('Checking the changes.');
  });

  it('falls back to a generic ack', () => {
    expect(ALL_ACK_PHRASES).toContain(pickAck('hmm okay then', null));
  });

  it('never repeats the previous ack twice in a row', () => {
    const first = pickAck('what does the loader do', null);
    const second = pickAck('what does the cleaner do', first);
    expect(second).not.toBe(first);
  });

  it('every phrase ends with terminal punctuation (TTS pacing)', () => {
    for (const p of ALL_ACK_PHRASES) expect(p).toMatch(/[.!?]$/);
  });
});

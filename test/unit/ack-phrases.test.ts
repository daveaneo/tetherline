import { describe, it, expect } from 'vitest';
import { pickAck, ALL_ACK_PHRASES, DEPTH_ACKS } from '../../packages/backend/src/session/ack-phrases.js';

describe('pickAck', () => {
  it('routes visual asks to the pull-up ack', () => {
    expect(pickAck('show me the auth flow', null)).toBe('Pulling that up now.');
    expect(pickAck('can you draw the pipeline', null)).toBe('Pulling that up now.');
  });

  it('routes questions to a look ack', () => {
    expect(pickAck('what does the loader do', null)).toBe('Let me take a look — one moment.');
    expect(pickAck('how is this wired together', null)).toBe('Let me take a look — one moment.');
  });

  it('routes change asks to the changes ack', () => {
    expect(pickAck('compare this to last week', null)).toBe('Checking the changes — one moment.');
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

  // Acks must sound like CONTINUATIONS, not closers — otherwise the silence
  // after the ack (classify + first-sentence generation) reads as "Hermes is
  // done" when it isn't (live 2026-06-11). A trailing/internal em-dash or a
  // "moment"/"now" keeps the gap reading as "working on it."
  it('every spoken ack reads as a continuation, not a closer', () => {
    const CONTINUATION = /—|…|\bmoment\b|\bnow\b/i;
    for (const p of [...ALL_ACK_PHRASES, ...DEPTH_ACKS]) {
      expect(CONTINUATION.test(p), `ack must imply continuation: "${p}"`).toBe(true);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { buildComprehensionLog } from '../../packages/backend/src/intelligence/comprehension-log.js';
import type { GrillSession } from '../../packages/backend/src/intelligence/grill.js';

const FIXED = () => new Date('2026-05-15T12:00:00.000Z');

function session(turns: GrillSession['turns'], extra: Partial<GrillSession> = {}): GrillSession {
  return {
    topic: 'auth',
    context: '',
    tone: 'coach',
    turns,
    done: true,
    ...extra,
  };
}

describe('comprehension-log builder', () => {
  it('counts evaluations and picks the first weak spot', () => {
    const log = buildComprehensionLog(
      session([
        { question: 'what signs the token?', answer: 'x', evaluation: 'strong' },
        { question: 'how is refresh handled?', answer: 'y', evaluation: 'weak' },
        { question: 'where is logout?', answer: 'z', evaluation: 'partial' },
      ]),
      FIXED,
    );
    expect(log.strong).toBe(1);
    expect(log.weak).toBe(1);
    expect(log.partial).toBe(1);
    expect(log.weakSpot).toBe('how is refresh handled?');
    expect(log.kind).toBe('comprehension');
    expect(log.createdAt).toBe('2026-05-15T12:00:00.000Z');
  });

  it('verdict is from ANSWERED ratio (abandoned grill ≠ weak)', () => {
    // Only one answered, and it was strong → solid, not "weak" just
    // because 5 questions went unanswered.
    const log = buildComprehensionLog(
      session([
        { question: 'q1', answer: 'a', evaluation: 'strong' },
        { question: 'q2' },
        { question: 'q3' },
      ]),
      FIXED,
    );
    expect(log.summary).toContain('solid');
    expect(log.asked).toBe(3);
  });

  it('weak grill reads as weak with the weak spot in the summary', () => {
    const log = buildComprehensionLog(
      session(
        [
          { question: 'how does the session middleware work?', answer: 'idk', evaluation: 'weak' },
          { question: 'q2', answer: 'no', evaluation: 'weak' },
        ],
        { finalNote: 'shaky on session handling' },
      ),
      FIXED,
    );
    expect(log.summary).toMatch(/auth: weak/);
    expect(log.summary).toMatch(/weak spot: how does the session middleware/);
    expect(log.finalNote).toBe('shaky on session handling');
  });

  it('no answers → untested, no weak spot, never throws', () => {
    const log = buildComprehensionLog(session([{ question: 'q1' }]), FIXED);
    expect(log.summary).toContain('untested');
    expect(log.weakSpot).toBeUndefined();
  });

  it('long weak-spot question is truncated for the shelf row', () => {
    const long = 'q '.repeat(80) + 'end';
    const log = buildComprehensionLog(
      session([{ question: long, answer: 'a', evaluation: 'weak' }]),
      FIXED,
    );
    expect(log.summary.length).toBeLessThan(long.length);
    expect(log.summary).toContain('…');
  });
});

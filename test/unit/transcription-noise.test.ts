/**
 * REGRESSION GUARD: Whisper / browser STT hallucinations during silence must
 * NOT trigger LLM filler responses ("I'm here and ready to help!"). User
 * reported this on 2026-04-25.
 */
import { describe, it, expect } from 'vitest';
import { isLikelyTranscriptionNoise } from '../../packages/backend/src/session/manager.js';

describe('isLikelyTranscriptionNoise', () => {
  it.each([
    'you',
    '.',
    'thanks for watching',
    'Thanks for watching!',
    'thank you',
    'Thanks',
    'subscribe',
    'um',
    'uh',
    'oh',
    '',
    '   ',
    'a',
    'hi',
  ])('drops noise: %s', (phrase) => {
    expect(isLikelyTranscriptionNoise(phrase)).toBe(true);
  });

  it.each([
    'what is this project about?',
    'tell me about the auth module',
    'how does the session manager work?',
    'why was capture refactored?',
    'show me concerns',
  ])('keeps real questions: %s', (phrase) => {
    expect(isLikelyTranscriptionNoise(phrase)).toBe(false);
  });

  it('keeps short module names (>= 3 chars) — these are legitimate "what about X?" follow-ups', () => {
    // The user might say just "auth?" or "ledger?" as a follow-up. The frontend
    // filter has a separate single-word heuristic; this backend filter only
    // catches known hallucination phrases + sub-3-char strings.
    expect(isLikelyTranscriptionNoise('auth')).toBe(false);
    expect(isLikelyTranscriptionNoise('ledger')).toBe(false);
  });
});

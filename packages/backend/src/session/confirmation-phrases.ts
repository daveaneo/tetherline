/**
 * Phrases that indicate the user has understood what was just explained.
 * Only counted as "confirmed" when GUARDED — within a short window of a
 * narration:briefing emit AND while voice state is listening — so idle
 * chatter like "got it, I need to grab coffee" doesn't accidentally mark
 * something as understood.
 */

const PHRASES = [
  // direct acknowledgement
  'got it',
  'understood',
  'makes sense',
  'that makes sense',
  'i got it',
  'i see',
  'i understand',
  'ok got it',
  'okay got it',
  'right',
  'right, that makes sense',
  'yes that makes sense',
  'that tracks',
  'yeah that tracks',
  'yep',
  'yup',
  // "move on" implies satisfaction with the explanation
  "i'm good",
  'sounds good',
  'cool',
  'nice',
  'clear',
  'that was clear',
  'i get it now',
  'got it now',
];

const PHRASE_SET = new Set(PHRASES.map(p => p.toLowerCase()));

/** Match a user utterance against the confirmation phrase list. Matches only
 *  when the utterance is short (<=6 words) and IS one of the recognized
 *  phrases. A longer utterance containing "got it" among other words (e.g.
 *  "got it, now tell me about ledger") is not a confirmation — it's a
 *  transition. Strict matching keeps the signal clean. */
export function isConfirmationPhrase(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;
  return PHRASE_SET.has(t);
}

export const CONFIRMATION_PHRASES = PHRASES;

/**
 * Instant spoken acknowledgments — emitted as seq 0 of the turn's answer
 * stream within milliseconds of the utterance, BEFORE intent
 * classification runs. Template-only by design: an LLM pick would cost the
 * exact latency the ack exists to hide. Keyword routing is best-effort
 * flavor, not classification — a mismatch ("Let me take a look." before a
 * navigation) is harmless.
 *
 * Every phrase here is pre-synthesized into the TTS audio cache at session
 * start so the ack's /api/audio/tts POST is a cache hit (~no synth delay).
 */

// Phrased as CONTINUATIONS (trailing/internal em-dash, "moment", "now") so the
// silence that follows — classify + first-sentence generation — reads as
// "working on it," not "done." (live 2026-06-11). Pinned by ack-phrases.test.
const VISUAL_ACKS = ['Pulling that up now.'];
const QUESTION_ACKS = ['Let me take a look — one moment.', 'Good question — give me a moment.'];
const CHANGE_ACKS = ['Checking the changes — one moment.'];
const GENERIC_ACKS = ['One moment.', 'Looking now.', 'Let me check on that now.'];

/** Depth-change acks (owned by the depth detector, pre-warmed here too). */
export const DEPTH_ACKS = ["Got it — I'll keep it short.", 'Sure — going deeper now.'];

export const ALL_ACK_PHRASES: string[] = [
  ...VISUAL_ACKS,
  ...QUESTION_ACKS,
  ...CHANGE_ACKS,
  ...GENERIC_ACKS,
];

function pickFrom(pool: string[], lastAck: string | null): string {
  const candidates = pool.filter(p => p !== lastAck);
  return (candidates.length > 0 ? candidates : pool)[0];
}

/** Pick an ack for this utterance, never repeating the previous one. */
export function pickAck(utterance: string, lastAck: string | null): string {
  const t = utterance.toLowerCase();
  if (/\b(show|draw|visuali[sz]e|diagram|sketch|picture)\b/.test(t)) {
    return pickFrom([...VISUAL_ACKS, ...GENERIC_ACKS], lastAck);
  }
  if (/\b(compare|diff|changed?|before and after)\b/.test(t)) {
    return pickFrom([...CHANGE_ACKS, ...GENERIC_ACKS], lastAck);
  }
  if (/\b(what|how|why|explain|tell me|where|who|when)\b/.test(t)) {
    return pickFrom([...QUESTION_ACKS, ...GENERIC_ACKS], lastAck);
  }
  return pickFrom(GENERIC_ACKS, lastAck);
}

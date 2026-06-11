/**
 * Pre-synthesizes the instant-ack phrases (and the steering hook) into the
 * TTS audio cache at server start, so the spoken ack's /api/audio/tts POST
 * is a cache hit. Without this the ack chunk is emitted in ~5ms but the
 * user still waits on Kokoro synth — the warm cache is what makes the ack
 * audible inside ~300ms.
 *
 * Cache key parity: /tts caches under voice key 'kokoro' for BOTH providers
 * (cacheVoice = voice ?? 'kokoro'), so we warm the same key.
 */
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { AudioCache } from './audio-cache.js';
import type { TTSProvider } from './provider.js';
import { KokoroTTSProvider } from './kokoro-tts.js';
import { OpenAITTSProvider } from './openai-tts.js';
import { ALL_ACK_PHRASES, DEPTH_ACKS } from '../session/ack-phrases.js';
import { STEERING_HOOK, ARTIFACT_REPLACEMENT_LINES } from '../session/answer-streamer.js';

const CACHE_VOICE = 'kokoro';

/** Every fixed phrase that is emitted as its OWN standalone TTS request — acks,
 *  the steering hook, the artifact replacement lines. Warming these means each
 *  plays from disk with no synth latency. (FLOW_BRIDGE_LINE is deliberately NOT
 *  here: coherentFlowOpener concatenates it into one combined opener utterance,
 *  so a standalone bridge cache key would never hit.) */
export const FIXED_SPOKEN_PHRASES: string[] = [
  ...ALL_ACK_PHRASES,
  ...DEPTH_ACKS,
  STEERING_HOOK,
  ...ARTIFACT_REPLACEMENT_LINES,
];

/** Synthesize each not-yet-cached phrase via `provider` into `cache` (under
 *  `voice`). Best-effort per phrase. Pure + injectable → unit-tested with a
 *  stub provider (no paid API). Returns the count actually synthesized. */
export async function warmPhrasesIntoCache(
  cache: AudioCache, provider: TTSProvider, phrases: string[], voice = CACHE_VOICE,
): Promise<number> {
  let synthesized = 0;
  for (const text of phrases) {
    if (cache.get(text, voice)) continue; // already warm — no provider call
    try {
      cache.set(text, voice, await provider.generateSpeech(text));
      synthesized += 1;
    } catch { /* best-effort per phrase */ }
  }
  return synthesized;
}

export async function prewarmSpokenAcks(db: Database, config: AppConfig): Promise<void> {
  const cache = new AudioCache(config.audioCachePath);
  const phrases = FIXED_SPOKEN_PHRASES.filter(text => !cache.get(text, CACHE_VOICE));
  if (phrases.length === 0) return;

  // The audio sidecar boots in parallel with the backend (model loading
  // takes a few seconds) — wait for a provider rather than warming into
  // the void. Same pattern as probeAudioSidecar in index.ts.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (await KokoroTTSProvider.isAvailable()) {
        await warmPhrasesIntoCache(cache, new KokoroTTSProvider('af_heart'), phrases);
        return;
      }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 3000));
  }

  // Kokoro never came up — warm via OpenAI if configured (same key the
  // /tts fallback would cache under anyway).
  const openaiKey = config.openaiApiKey ?? db.getSettingsRepo().get('openaiApiKey');
  if (!openaiKey) return;
  try {
    await warmPhrasesIntoCache(cache, new OpenAITTSProvider(openaiKey as string, 'coral'), phrases);
  } catch { /* best-effort */ }
}

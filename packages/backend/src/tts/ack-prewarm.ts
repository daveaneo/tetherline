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
import { KokoroTTSProvider } from './kokoro-tts.js';
import { OpenAITTSProvider } from './openai-tts.js';
import { ALL_ACK_PHRASES, DEPTH_ACKS } from '../session/ack-phrases.js';
import { STEERING_HOOK } from '../session/answer-streamer.js';

const CACHE_VOICE = 'kokoro';

export async function prewarmSpokenAcks(db: Database, config: AppConfig): Promise<void> {
  const cache = new AudioCache(config.audioCachePath);
  const phrases = [...ALL_ACK_PHRASES, ...DEPTH_ACKS, STEERING_HOOK]
    .filter(text => !cache.get(text, CACHE_VOICE));
  if (phrases.length === 0) return;

  // The audio sidecar boots in parallel with the backend (model loading
  // takes a few seconds) — wait for a provider rather than warming into
  // the void. Same pattern as probeAudioSidecar in index.ts.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (await KokoroTTSProvider.isAvailable()) {
        const provider = new KokoroTTSProvider('af_heart');
        for (const text of phrases) {
          try { cache.set(text, CACHE_VOICE, await provider.generateSpeech(text)); }
          catch { /* best-effort per phrase */ }
        }
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
    const provider = new OpenAITTSProvider(openaiKey as string, 'coral');
    for (const text of phrases) {
      try { cache.set(text, CACHE_VOICE, await provider.generateSpeech(text)); }
      catch { /* best-effort per phrase */ }
    }
  } catch { /* best-effort */ }
}

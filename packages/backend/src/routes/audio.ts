import { Router } from 'express';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { KokoroTTSProvider } from '../tts/kokoro-tts.js';
import { OpenAITTSProvider } from '../tts/openai-tts.js';
import { AudioCache } from '../tts/audio-cache.js';

export function createAudioRoutes(db: Database, config: AppConfig): Router {
  const router = Router();
  const cache = new AudioCache(config.audioCachePath);

  // Generate TTS audio for a text segment
  // Priority: cache → Kokoro (local) → OpenAI (cloud) → error
  router.post('/tts', async (req, res) => {
    const { text, voice } = req.body;

    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const cacheVoice = voice ?? 'kokoro';

    // Check cache
    const cached = cache.get(text, cacheVoice);
    if (cached) {
      const contentType = cached[0] === 0x52 ? 'audio/wav' : 'audio/mpeg'; // 'R' = RIFF/WAV
      res.set('Content-Type', contentType);
      res.set('Content-Length', String(cached.length));
      res.send(cached);
      return;
    }

    // Try Kokoro (local) first
    try {
      const kokoroAvailable = await KokoroTTSProvider.isAvailable();
      if (kokoroAvailable) {
        const provider = new KokoroTTSProvider(voice ?? 'af_heart');
        const audio = await provider.generateSpeech(text);
        cache.set(text, cacheVoice, audio);

        res.set('Content-Type', 'audio/wav');
        res.set('Content-Length', String(audio.length));
        res.send(audio);
        return;
      }
    } catch (err: any) {
      console.error('Kokoro TTS error (falling back):', err.message);
    }

    // Fall back to OpenAI
    const openaiKey = config.openaiApiKey ?? db.getSettingsRepo().get('openaiApiKey');
    if (openaiKey) {
      try {
        const provider = new OpenAITTSProvider(openaiKey as string, voice ?? 'coral');
        const audio = await provider.generateSpeech(text);
        cache.set(text, cacheVoice, audio);

        res.set('Content-Type', 'audio/mpeg');
        res.set('Content-Length', String(audio.length));
        res.send(audio);
        return;
      } catch (err: any) {
        console.error('OpenAI TTS error:', err.message);
      }
    }

    res.status(503).json({
      error: 'No TTS available. Start the Kokoro server (python kokoro-server.py) or set OPENAI_API_KEY.',
    });
  });

  // Check which TTS providers are available
  router.get('/status', async (_req, res) => {
    const kokoroAvailable = await KokoroTTSProvider.isAvailable();
    const openaiAvailable = !!(config.openaiApiKey ?? db.getSettingsRepo().get('openaiApiKey'));

    res.json({
      kokoro: kokoroAvailable,
      openai: openaiAvailable,
      browser: true, // always available as fallback
      active: kokoroAvailable ? 'kokoro' : openaiAvailable ? 'openai' : 'browser',
    });
  });

  return router;
}

import { Router } from 'express';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { OpenAITTSProvider } from '../tts/openai-tts.js';
import { AudioCache } from '../tts/audio-cache.js';

export function createAudioRoutes(db: Database, config: AppConfig): Router {
  const router = Router();
  const cache = new AudioCache(config.audioCachePath);

  // Generate TTS audio for a text segment
  router.post('/tts', async (req, res) => {
    const { text, voice = 'coral' } = req.body;

    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    // Check cache
    const cached = cache.get(text, voice);
    if (cached) {
      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Length', String(cached.length));
      res.send(cached);
      return;
    }

    // Check for API key
    const openaiKey = config.openaiApiKey ?? db.getSettingsRepo().get('openaiApiKey');
    if (!openaiKey) {
      res.status(400).json({ error: 'OpenAI API key not configured. Use browser TTS or set OPENAI_API_KEY.' });
      return;
    }

    try {
      const provider = new OpenAITTSProvider(openaiKey as string, voice);
      const audio = await provider.generateSpeech(text);
      cache.set(text, voice, audio);

      res.set('Content-Type', 'audio/mpeg');
      res.set('Content-Length', String(audio.length));
      res.send(audio);
    } catch (err: any) {
      console.error('TTS error:', err);
      res.status(500).json({ error: 'TTS generation failed: ' + err.message });
    }
  });

  return router;
}

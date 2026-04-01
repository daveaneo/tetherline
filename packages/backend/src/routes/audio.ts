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

  // Transcribe audio via local Whisper
  router.post('/transcribe', async (req, res) => {
    const SIDECAR_URL = process.env.AUDIO_SERVER_URL ?? 'http://127.0.0.1:3848';

    try {
      // Forward the raw audio to the sidecar
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const audioBuffer = Buffer.concat(chunks);

      const contentType = req.headers['content-type'] ?? 'audio/wav';
      const response = await fetch(`${SIDECAR_URL}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: audioBuffer,
      });

      if (!response.ok) {
        res.status(502).json({ error: 'Transcription service unavailable' });
        return;
      }

      const result = await response.json() as any;
      res.json(result);
    } catch (err: any) {
      res.status(503).json({ error: 'Transcription failed: ' + err.message });
    }
  });

  // Check which audio providers are available
  router.get('/status', async (_req, res) => {
    const SIDECAR_URL = process.env.AUDIO_SERVER_URL ?? 'http://127.0.0.1:3848';
    let sidecarStatus: any = null;
    try {
      const r = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) sidecarStatus = await r.json();
    } catch {}

    const kokoroAvailable = !!sidecarStatus?.tts;
    const whisperAvailable = !!sidecarStatus?.stt;
    const openaiAvailable = !!(config.openaiApiKey ?? db.getSettingsRepo().get('openaiApiKey'));

    res.json({
      kokoro: kokoroAvailable,
      whisper: whisperAvailable,
      openai: openaiAvailable,
      browser: true,
      activeTts: kokoroAvailable ? 'kokoro' : openaiAvailable ? 'openai' : 'browser',
      activeStt: whisperAvailable ? 'whisper' : 'browser',
    });
  });

  return router;
}

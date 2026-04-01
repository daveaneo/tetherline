import type { TTSProvider } from './provider.js';

const KOKORO_URL = process.env.KOKORO_URL ?? 'http://127.0.0.1:3848';

export class KokoroTTSProvider implements TTSProvider {
  private voice: string;

  constructor(voice: string = 'af_heart') {
    this.voice = voice;
  }

  async generateSpeech(text: string): Promise<Buffer> {
    const response = await fetch(`${KOKORO_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: this.voice }),
    });

    if (!response.ok) {
      throw new Error(`Kokoro TTS failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  static async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${KOKORO_URL}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

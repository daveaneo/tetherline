import OpenAI from 'openai';
import type { TTSProvider } from './provider.js';

export class OpenAITTSProvider implements TTSProvider {
  private client: OpenAI;
  private voice: string;
  private instructions: string;

  constructor(apiKey: string, voice: string = 'coral') {
    this.client = new OpenAI({ apiKey });
    this.voice = voice;
    this.instructions =
      'Speak in a calm, knowledgeable tone, like a senior engineer explaining ' +
      'code changes to a colleague. Moderate pace. Clear enunciation of technical terms. ' +
      'Do not add sound effects or music.';
  }

  async generateSpeech(text: string): Promise<Buffer> {
    const response = await this.client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: this.voice as any,
      input: text,
      instructions: this.instructions,
      response_format: 'mp3',
    });

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

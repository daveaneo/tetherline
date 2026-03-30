export interface TTSProvider {
  generateSpeech(text: string): Promise<Buffer>;
}

export type TTSProviderType = 'openai' | 'browser';

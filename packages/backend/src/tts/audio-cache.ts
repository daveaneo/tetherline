import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class AudioCache {
  constructor(private cacheDir: string) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  private getKey(text: string, voice: string): string {
    const hash = crypto.createHash('sha256').update(`${voice}:${text}`).digest('hex').slice(0, 16);
    return hash;
  }

  get(text: string, voice: string): Buffer | null {
    const key = this.getKey(text, voice);
    const filePath = path.join(this.cacheDir, `${key}.mp3`);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }
    return null;
  }

  set(text: string, voice: string, audio: Buffer): void {
    const key = this.getKey(text, voice);
    const filePath = path.join(this.cacheDir, `${key}.mp3`);
    fs.writeFileSync(filePath, audio);
  }

  has(text: string, voice: string): boolean {
    const key = this.getKey(text, voice);
    const filePath = path.join(this.cacheDir, `${key}.mp3`);
    return fs.existsSync(filePath);
  }
}

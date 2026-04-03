import crypto from 'crypto';
import fs from 'fs';

export function hashFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

export function hashString(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

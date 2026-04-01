import path from 'path';
import os from 'os';
import { DEFAULT_PORT, DB_FILENAME, AUDIO_CACHE_DIR } from '@interactive-reviewer/shared';

export type IntelligenceMode = 'local' | 'cloud' | 'auto';

export interface AppConfig {
  port: number;
  repoPath: string;
  dataDir: string;
  dbPath: string;
  audioCachePath: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  intelligenceMode: IntelligenceMode;
}

export function loadConfig(overrides: { port?: number; repoPath?: string } = {}): AppConfig {
  const dataDir = path.join(os.homedir(), '.interactive-reviewer');

  // 'local' = use claude CLI (subscription), 'cloud' = use API key, 'auto' = try local first
  const intelligenceMode = (process.env.INTELLIGENCE_MODE as IntelligenceMode) ?? 'auto';

  return {
    port: overrides.port ?? parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10),
    repoPath: overrides.repoPath ?? process.env.REPO_PATH ?? process.cwd(),
    dataDir,
    dbPath: path.join(dataDir, DB_FILENAME),
    audioCachePath: path.join(dataDir, AUDIO_CACHE_DIR),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    intelligenceMode,
  };
}

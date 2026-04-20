import path from 'path';
import os from 'os';
import fs from 'fs';
import { DEFAULT_PORT, DB_FILENAME, AUDIO_CACHE_DIR } from '@tetherline/shared';

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
  const dataDir = path.join(os.homedir(), '.tetherline');
  migrateLegacyDataDir(dataDir);

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

// One-time rename: ~/.interactive-reviewer → ~/.tetherline, and the legacy
// db file inside it → tetherline.db. Preserves sessions, annotations, etc.
function migrateLegacyDataDir(targetDir: string) {
  const legacyDir = path.join(os.homedir(), '.interactive-reviewer');
  if (!fs.existsSync(legacyDir) || fs.existsSync(targetDir)) return;
  try {
    fs.renameSync(legacyDir, targetDir);
    const legacyDb = path.join(targetDir, 'interactive-reviewer.db');
    const newDb = path.join(targetDir, DB_FILENAME);
    if (fs.existsSync(legacyDb) && !fs.existsSync(newDb)) {
      fs.renameSync(legacyDb, newDb);
    }
    console.log('[tetherline] migrated data dir from ~/.interactive-reviewer');
  } catch (err) {
    console.warn('[tetherline] legacy data dir migration failed:', err);
  }
}

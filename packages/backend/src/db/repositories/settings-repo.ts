import type BetterSqlite3 from 'better-sqlite3';
import { DEFAULT_SETTINGS, type Settings } from '@tetherline/shared';

export class SettingsRepository {
  constructor(private db: BetterSqlite3.Database) {}

  getAll(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as any[];
    const stored: Record<string, any> = {};
    for (const row of rows) {
      stored[row.key] = JSON.parse(row.value);
    }
    return { ...DEFAULT_SETTINGS, ...stored } as Settings;
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    if (!row) return DEFAULT_SETTINGS[key];
    return JSON.parse(row.value);
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, JSON.stringify(value));
  }

  update(updates: Partial<Settings>): void {
    const upsert = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `);
    const transaction = this.db.transaction((entries: [string, any][]) => {
      for (const [key, value] of entries) {
        upsert.run(key, JSON.stringify(value));
      }
    });
    transaction(Object.entries(updates));
  }
}

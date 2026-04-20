import type BetterSqlite3 from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { UnderstandingItem, UnderstandingLevel, UnderstandingStatus, UnderstandingLayer, UnderstandingState } from '@tetherline/shared';

export class UnderstandingRepository {
  constructor(private db: BetterSqlite3.Database) {}

  getForRepo(repoPath: string): UnderstandingItem[] {
    const rows = this.db.prepare('SELECT * FROM understanding WHERE repo_path = ?').all(repoPath) as any[];
    return rows.map(this.rowToItem);
  }

  getByLayer(repoPath: string, layer: UnderstandingLevel): UnderstandingItem[] {
    const rows = this.db.prepare('SELECT * FROM understanding WHERE repo_path = ? AND layer = ?').all(repoPath, layer) as any[];
    return rows.map(this.rowToItem);
  }

  upsertItem(item: Omit<UnderstandingItem, 'id'>): void {
    this.db.prepare(`
      INSERT INTO understanding (id, repo_path, layer, item_id, item_name, parent_id, status, last_reviewed_at, stale_since)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_path, layer, item_id) DO UPDATE SET
        item_name = excluded.item_name,
        parent_id = excluded.parent_id,
        status = excluded.status,
        last_reviewed_at = excluded.last_reviewed_at,
        stale_since = excluded.stale_since,
        updated_at = datetime('now')
    `).run(uuid(), item.repoPath, item.layer, item.itemId, item.itemName, item.parentId ?? null, item.status, item.lastReviewedAt ?? null, item.staleSince ?? null);
  }

  markUnderstood(repoPath: string, layer: UnderstandingLevel, itemId: string): void {
    this.db.prepare(`
      UPDATE understanding SET status = 'understood', last_reviewed_at = datetime('now'), stale_since = NULL, updated_at = datetime('now')
      WHERE repo_path = ? AND layer = ? AND item_id = ?
    `).run(repoPath, layer, itemId);
  }

  markStale(repoPath: string, layer: UnderstandingLevel, itemId: string): void {
    this.db.prepare(`
      UPDATE understanding SET status = 'stale', stale_since = datetime('now'), updated_at = datetime('now')
      WHERE repo_path = ? AND layer = ? AND item_id = ? AND status = 'understood'
    `).run(repoPath, layer, itemId);
  }

  getState(repoPath: string): UnderstandingState {
    const levels: UnderstandingLevel[] = ['project', 'architecture', 'component', 'file', 'code'];
    const layers: UnderstandingLayer[] = levels.map(level => {
      const items = this.getByLayer(repoPath, level);
      const total = items.length;
      const understood = items.filter(i => i.status === 'understood').length;
      const stale = items.filter(i => i.status === 'stale').length;
      return {
        level,
        percentage: total > 0 ? Math.round((understood / total) * 100) : 0,
        total,
        understood,
        stale,
      };
    });

    const totalItems = layers.reduce((s, l) => s + l.total, 0);
    const totalUnderstood = layers.reduce((s, l) => s + l.understood, 0);

    return {
      repoPath,
      layers,
      overallPercentage: totalItems > 0 ? Math.round((totalUnderstood / totalItems) * 100) : 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  private rowToItem(row: any): UnderstandingItem {
    return {
      id: row.id,
      repoPath: row.repo_path,
      layer: row.layer,
      itemId: row.item_id,
      itemName: row.item_name,
      parentId: row.parent_id,
      status: row.status,
      lastReviewedAt: row.last_reviewed_at,
      staleSince: row.stale_since,
    };
  }
}

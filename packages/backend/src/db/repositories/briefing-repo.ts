import type BetterSqlite3 from 'better-sqlite3';
import type { Briefing, BriefingLayer, BriefingSummary } from '@tetherline/shared';

interface Row {
  id: string;
  repo_path: string;
  layer: string;
  title: string;
  opener: string;
  detail: string | null;
  talking_points: string;
  children: string;
  parent: string | null;
  visual_cue: string | null;
  estimated_seconds: number;
  source_hash: string;
  cached_at: string;
}

function rowToBriefing(r: Row): Briefing {
  return {
    id: r.id,
    repoPath: r.repo_path,
    layer: r.layer as BriefingLayer,
    title: r.title,
    opener: r.opener,
    detail: r.detail ?? undefined,
    talkingPoints: JSON.parse(r.talking_points || '[]'),
    children: JSON.parse(r.children || '[]'),
    parent: r.parent,
    visualCue: r.visual_cue ? JSON.parse(r.visual_cue) : undefined,
    estimatedSeconds: r.estimated_seconds,
    sourceHash: r.source_hash,
    cachedAt: r.cached_at,
  };
}

export class BriefingRepository {
  constructor(private db: BetterSqlite3.Database) {}

  get(repoPath: string, id: string): Briefing | null {
    const row = this.db
      .prepare('SELECT * FROM briefings WHERE repo_path = ? AND id = ?')
      .get(repoPath, id) as Row | undefined;
    return row ? rowToBriefing(row) : null;
  }

  getByLayer(repoPath: string, layer: BriefingLayer): Briefing[] {
    const rows = this.db
      .prepare('SELECT * FROM briefings WHERE repo_path = ? AND layer = ? ORDER BY id')
      .all(repoPath, layer) as Row[];
    return rows.map(rowToBriefing);
  }

  getChildren(repoPath: string, parentId: string): Briefing[] {
    const rows = this.db
      .prepare('SELECT * FROM briefings WHERE repo_path = ? AND parent = ? ORDER BY id')
      .all(repoPath, parentId) as Row[];
    return rows.map(rowToBriefing);
  }

  listAll(repoPath: string): BriefingSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, layer, title, estimated_seconds, parent,
          (SELECT COUNT(*) FROM briefings c WHERE c.repo_path = b.repo_path AND c.parent = b.id) AS child_count
         FROM briefings b
         WHERE repo_path = ? ORDER BY layer, id`,
      )
      .all(repoPath) as Array<Row & { child_count: number }>;
    return rows.map(r => ({
      id: r.id,
      layer: r.layer as BriefingLayer,
      title: r.title,
      estimatedSeconds: r.estimated_seconds,
      parent: r.parent,
      childCount: r.child_count,
    }));
  }

  upsert(b: Briefing): void {
    this.db
      .prepare(
        `INSERT INTO briefings
          (id, repo_path, layer, title, opener, detail, talking_points, children, parent, visual_cue, estimated_seconds, source_hash, cached_at)
         VALUES (@id, @repo_path, @layer, @title, @opener, @detail, @talking_points, @children, @parent, @visual_cue, @estimated_seconds, @source_hash, @cached_at)
         ON CONFLICT(repo_path, id) DO UPDATE SET
           layer = excluded.layer,
           title = excluded.title,
           opener = excluded.opener,
           detail = excluded.detail,
           talking_points = excluded.talking_points,
           children = excluded.children,
           parent = excluded.parent,
           visual_cue = excluded.visual_cue,
           estimated_seconds = excluded.estimated_seconds,
           source_hash = excluded.source_hash,
           cached_at = excluded.cached_at`,
      )
      .run({
        id: b.id,
        repo_path: b.repoPath,
        layer: b.layer,
        title: b.title,
        opener: b.opener,
        detail: b.detail ?? null,
        talking_points: JSON.stringify(b.talkingPoints),
        children: JSON.stringify(b.children),
        parent: b.parent,
        visual_cue: b.visualCue ? JSON.stringify(b.visualCue) : null,
        estimated_seconds: b.estimatedSeconds,
        source_hash: b.sourceHash,
        cached_at: b.cachedAt,
      });
  }

  delete(repoPath: string, id: string): void {
    this.db.prepare('DELETE FROM briefings WHERE repo_path = ? AND id = ?').run(repoPath, id);
  }

  deleteForRepo(repoPath: string): void {
    this.db.prepare('DELETE FROM briefings WHERE repo_path = ?').run(repoPath);
  }

  /** Stamp a briefing as just delivered. The session manager calls this
   *  every time it emits a briefing's narration so the next session
   *  start can decide whether to re-deliver, abbreviate, or skip
   *  based on how recently the user heard it. */
  markDelivered(repoPath: string, id: string): void {
    this.db
      .prepare(`UPDATE briefings SET last_delivered_at = datetime('now') WHERE repo_path = ? AND id = ?`)
      .run(repoPath, id);
  }

  /** Returns minutes since last delivery, or null if never delivered. */
  minutesSinceLastDelivery(repoPath: string, id: string): number | null {
    const row = this.db
      .prepare('SELECT last_delivered_at FROM briefings WHERE repo_path = ? AND id = ?')
      .get(repoPath, id) as { last_delivered_at: string | null } | undefined;
    if (!row?.last_delivered_at) return null;
    const last = new Date(row.last_delivered_at + 'Z').getTime();
    if (Number.isNaN(last)) return null;
    return Math.floor((Date.now() - last) / 60_000);
  }
}

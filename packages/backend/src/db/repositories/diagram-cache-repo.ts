/**
 * Diagram cache — pre-warmed Logic + File view payloads keyed by
 * (repo, scope, view). The session-start warm fills these so first-
 * level radial-map drilling is instant; cache misses fall back to
 * on-the-fly composition with a visible loading state.
 */
import type BetterSqlite3 from 'better-sqlite3';

export type DiagramView = 'logic' | 'file';

export interface DiagramNode {
  id: string;
  /** Display title — short. */
  label: string;
  /** Optional one-line description (≤80 chars). */
  description?: string;
  /** Concept role (logic view) — 'producer' | 'consumer' | 'transform'
   *  | 'guard' | 'sink' | 'source' — purely visual hint. */
  role?: string;
  /** Files this node implements / lives in (logic view). Empty for
   *  file-view nodes (the node IS the file). */
  implementsFiles?: string[];
  /** Comprehension level for the halo. */
  level?: 'unknown' | 'mentioned' | 'heard' | 'engaged' | 'explained' | 'confirmed';
  /** Passed a grill / perfect quiz — a separate active-recall QA proof,
   *  independent of `level`. Overlaid live at read time (not cached). */
  grilled?: boolean;
  /** v3: briefing narration actually finished playing (Seen-coverage). */
  seen?: boolean;
  /** v2 active-recall ratios, overlaid live (not cached). */
  quizCorrect?: number;
  quizTotal?: number;
  grillStrong?: number;
  grillAsked?: number;
  /** 0..1 visual size hint. Drives node-radius rendering. */
  weight?: number;
  /** Briefing id this node maps to, if any — clicking sends
   *  `tell me about <node>` which the navigator routes to this. */
  briefingId?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** Edge semantics — drives stroke style (solid for produces/consumes,
   *  dashed for configures/guards, etc.). 'contains' is the
   *  center→satellite parent-of edge the extractor always emits and
   *  the renderer special-cases (HermesDiagram edge.kind==='contains').
   */
  kind?: 'produces' | 'consumes' | 'configures' | 'guards' | 'imports' | 'contains';
  label?: string;
}

export interface DiagramRow {
  repoPath: string;
  scope: string;
  view: DiagramView;
  title: string;
  subtitle: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  sourceHash: string;
  generatedAt: string;
}

export class DiagramCacheRepository {
  constructor(private db: BetterSqlite3.Database) {}

  get(repoPath: string, scope: string, view: DiagramView): DiagramRow | null {
    const row = this.db.prepare(
      `SELECT * FROM diagram_cache WHERE repo_path = ? AND scope = ? AND view = ?`,
    ).get(repoPath, scope, view) as any;
    if (!row) return null;
    return rowToDiagram(row);
  }

  listForRepo(repoPath: string): DiagramRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM diagram_cache WHERE repo_path = ?`,
    ).all(repoPath) as any[];
    return rows.map(rowToDiagram);
  }

  upsert(row: DiagramRow): void {
    this.db.prepare(
      `INSERT INTO diagram_cache
        (repo_path, scope, view, title, subtitle, nodes_json, edges_json, source_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_path, scope, view) DO UPDATE SET
         title=excluded.title,
         subtitle=excluded.subtitle,
         nodes_json=excluded.nodes_json,
         edges_json=excluded.edges_json,
         source_hash=excluded.source_hash,
         generated_at=datetime('now')`,
    ).run(
      row.repoPath, row.scope, row.view, row.title, row.subtitle,
      JSON.stringify(row.nodes), JSON.stringify(row.edges), row.sourceHash,
    );
  }

  /** Drop a single diagram (used when underlying briefing drift makes
   *  the cached payload stale and we don't want to serve it). */
  invalidate(repoPath: string, scope: string, view: DiagramView): void {
    this.db.prepare(
      `DELETE FROM diagram_cache WHERE repo_path = ? AND scope = ? AND view = ?`,
    ).run(repoPath, scope, view);
  }
}

function rowToDiagram(row: any): DiagramRow {
  return {
    repoPath: row.repo_path,
    scope: row.scope,
    view: row.view,
    title: row.title,
    subtitle: row.subtitle,
    nodes: JSON.parse(row.nodes_json || '[]'),
    edges: JSON.parse(row.edges_json || '[]'),
    sourceHash: row.source_hash,
    generatedAt: row.generated_at,
  };
}

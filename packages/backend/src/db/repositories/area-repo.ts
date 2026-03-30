import type BetterSqlite3 from 'better-sqlite3';
import type { Area, AreaWithContent } from '@interactive-reviewer/shared';

export class AreaRepository {
  constructor(private db: BetterSqlite3.Database) {}

  createArea(area: Area & { sessionId: string }): void {
    this.db.prepare(`
      INSERT INTO areas (id, session_id, name, description, order_index, commit_hashes, affected_files, significance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      area.id, area.sessionId, area.name, area.description, area.orderIndex,
      JSON.stringify(area.commitHashes), JSON.stringify(area.affectedFiles), area.significance
    );
  }

  getAreasForSession(sessionId: string): AreaWithContent[] {
    const rows = this.db.prepare('SELECT * FROM areas WHERE session_id = ? ORDER BY order_index').all(sessionId) as any[];
    return rows.map(this.rowToArea);
  }

  updateArea(id: string, updates: Partial<{
    narrativeText: string;
    narrationSegments: string;
    architectureNodes: string;
    architectureEdges: string;
    reviewed: boolean;
    reviewedAt: string;
    deepDiveGenerated: boolean;
    deepDiveContent: string;
  }>): void {
    const sets: string[] = [];
    const values: any[] = [];
    if (updates.narrativeText !== undefined) { sets.push('narrative_text = ?'); values.push(updates.narrativeText); }
    if (updates.narrationSegments !== undefined) { sets.push('narration_segments = ?'); values.push(updates.narrationSegments); }
    if (updates.architectureNodes !== undefined) { sets.push('architecture_nodes = ?'); values.push(updates.architectureNodes); }
    if (updates.architectureEdges !== undefined) { sets.push('architecture_edges = ?'); values.push(updates.architectureEdges); }
    if (updates.reviewed !== undefined) { sets.push('reviewed = ?'); values.push(updates.reviewed ? 1 : 0); }
    if (updates.reviewedAt !== undefined) { sets.push('reviewed_at = ?'); values.push(updates.reviewedAt); }
    if (updates.deepDiveGenerated !== undefined) { sets.push('deep_dive_generated = ?'); values.push(updates.deepDiveGenerated ? 1 : 0); }
    if (updates.deepDiveContent !== undefined) { sets.push('deep_dive_content = ?'); values.push(updates.deepDiveContent); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE areas SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  private rowToArea(row: any): AreaWithContent {
    return {
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      description: row.description,
      orderIndex: row.order_index,
      commitHashes: JSON.parse(row.commit_hashes),
      affectedFiles: JSON.parse(row.affected_files),
      significance: row.significance,
      narrativeText: row.narrative_text,
      narrationSegments: JSON.parse(row.narration_segments || '[]'),
      architectureNodes: JSON.parse(row.architecture_nodes || '[]'),
      architectureEdges: JSON.parse(row.architecture_edges || '[]'),
      deepDiveGenerated: !!row.deep_dive_generated,
      deepDiveContent: row.deep_dive_content ? JSON.parse(row.deep_dive_content) : undefined,
      reviewed: !!row.reviewed,
      reviewedAt: row.reviewed_at,
    };
  }
}

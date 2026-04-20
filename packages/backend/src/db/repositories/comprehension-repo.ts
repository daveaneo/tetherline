import type BetterSqlite3 from 'better-sqlite3';
import {
  type ComprehensionItem,
  type ComprehensionLevel,
  type ComprehensionItemLayer,
  type ComprehensionMap,
  COMPREHENSION_ORDER,
} from '@tetherline/shared';

interface Row {
  repo_path: string;
  item_id: string;
  layer: string;
  label: string;
  level: string;
  narration_seconds_heard: number;
  questions_asked: number;
  last_touched_at: string;
  last_session_id: string | null;
}

function rowToItem(r: Row): ComprehensionItem {
  return {
    repoPath: r.repo_path,
    itemId: r.item_id,
    layer: r.layer as ComprehensionItemLayer,
    label: r.label,
    level: r.level as ComprehensionLevel,
    narrationSecondsHeard: r.narration_seconds_heard,
    questionsAsked: r.questions_asked,
    lastTouchedAt: r.last_touched_at,
    lastSessionId: r.last_session_id,
  };
}

export class ComprehensionRepository {
  constructor(private db: BetterSqlite3.Database) {}

  get(repoPath: string, itemId: string): ComprehensionItem | null {
    const row = this.db
      .prepare('SELECT * FROM comprehension WHERE repo_path = ? AND item_id = ?')
      .get(repoPath, itemId) as Row | undefined;
    return row ? rowToItem(row) : null;
  }

  getAll(repoPath: string): ComprehensionItem[] {
    const rows = this.db
      .prepare('SELECT * FROM comprehension WHERE repo_path = ? ORDER BY layer, item_id')
      .all(repoPath) as Row[];
    return rows.map(rowToItem);
  }

  upsert(item: ComprehensionItem): void {
    this.db
      .prepare(
        `INSERT INTO comprehension
          (repo_path, item_id, layer, label, level, narration_seconds_heard, questions_asked, last_touched_at, last_session_id)
         VALUES (@repo_path, @item_id, @layer, @label, @level, @narration_seconds_heard, @questions_asked, @last_touched_at, @last_session_id)
         ON CONFLICT(repo_path, item_id) DO UPDATE SET
           layer = excluded.layer,
           label = excluded.label,
           level = excluded.level,
           narration_seconds_heard = excluded.narration_seconds_heard,
           questions_asked = excluded.questions_asked,
           last_touched_at = excluded.last_touched_at,
           last_session_id = excluded.last_session_id`,
      )
      .run({
        repo_path: item.repoPath,
        item_id: item.itemId,
        layer: item.layer,
        label: item.label,
        level: item.level,
        narration_seconds_heard: item.narrationSecondsHeard,
        questions_asked: item.questionsAsked,
        last_touched_at: item.lastTouchedAt,
        last_session_id: item.lastSessionId,
      });
  }

  /** Record a passive observation. Transitions the level forward if the new
   *  level is strictly higher than the current one. Never regresses. */
  observe(
    repoPath: string,
    itemId: string,
    layer: ComprehensionItemLayer,
    label: string,
    proposedLevel: ComprehensionLevel,
    opts: {
      sessionId?: string;
      narrationSecondsHeard?: number;
      questionsAsked?: number;
    } = {},
  ): ComprehensionItem {
    const existing = this.get(repoPath, itemId);
    const now = new Date().toISOString();
    const currentIdx = existing ? COMPREHENSION_ORDER.indexOf(existing.level) : -1;
    const proposedIdx = COMPREHENSION_ORDER.indexOf(proposedLevel);
    const level = proposedIdx > currentIdx ? proposedLevel : existing?.level ?? proposedLevel;

    const item: ComprehensionItem = {
      repoPath,
      itemId,
      layer,
      label,
      level,
      narrationSecondsHeard:
        (existing?.narrationSecondsHeard ?? 0) + (opts.narrationSecondsHeard ?? 0),
      questionsAsked: (existing?.questionsAsked ?? 0) + (opts.questionsAsked ?? 0),
      lastTouchedAt: now,
      lastSessionId: opts.sessionId ?? existing?.lastSessionId ?? null,
    };
    this.upsert(item);
    return item;
  }

  /** Regress an item's level (e.g. staleness after code changes). */
  degrade(repoPath: string, itemId: string, toLevel: ComprehensionLevel): void {
    const existing = this.get(repoPath, itemId);
    if (!existing) return;
    const currentIdx = COMPREHENSION_ORDER.indexOf(existing.level);
    const targetIdx = COMPREHENSION_ORDER.indexOf(toLevel);
    if (targetIdx >= currentIdx) return;
    this.upsert({ ...existing, level: toLevel, lastTouchedAt: new Date().toISOString() });
  }

  buildMap(repoPath: string): ComprehensionMap {
    const items = this.getAll(repoPath);
    const totals: Record<ComprehensionLevel, number> = {
      unknown: 0, mentioned: 0, heard: 0, engaged: 0, explained: 0, confirmed: 0,
    };
    for (const item of items) totals[item.level] += 1;
    return { repoPath, items, totals };
  }

  /** Multi-repo aggregate. */
  buildMapAcrossRepos(repoPaths: string[]): ComprehensionMap[] {
    return repoPaths.map(p => this.buildMap(p));
  }
}

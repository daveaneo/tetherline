import type BetterSqlite3 from 'better-sqlite3';
import {
  type ComprehensionItem,
  type ComprehensionLevel,
  type ComprehensionItemLayer,
  type ComprehensionMap,
  type WeakSpot,
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
  grilled: number;
  seen: number;
  quiz_correct: number;
  quiz_total: number;
  grill_strong: number;
  grill_asked: number;
  last_touched_at: string;
  last_session_id: string | null;
}

interface WeakSpotRow {
  repo_path: string;
  item_id: string;
  question: string;
  source: string;
  created_at: string;
  resolved_at: string | null;
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
    grilled: r.grilled === 1,
    seen: r.seen === 1,
    quizCorrect: r.quiz_correct,
    quizTotal: r.quiz_total,
    grillStrong: r.grill_strong,
    grillAsked: r.grill_asked,
    lastTouchedAt: r.last_touched_at,
    lastSessionId: r.last_session_id,
  };
}

function rowToWeakSpot(r: WeakSpotRow): WeakSpot {
  return {
    repoPath: r.repo_path,
    itemId: r.item_id,
    question: r.question,
    source: r.source as 'grill' | 'quiz',
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
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
          (repo_path, item_id, layer, label, level, narration_seconds_heard, questions_asked, grilled, seen, quiz_correct, quiz_total, grill_strong, grill_asked, last_touched_at, last_session_id)
         VALUES (@repo_path, @item_id, @layer, @label, @level, @narration_seconds_heard, @questions_asked, @grilled, @seen, @quiz_correct, @quiz_total, @grill_strong, @grill_asked, @last_touched_at, @last_session_id)
         ON CONFLICT(repo_path, item_id) DO UPDATE SET
           layer = excluded.layer,
           label = excluded.label,
           level = excluded.level,
           narration_seconds_heard = excluded.narration_seconds_heard,
           questions_asked = excluded.questions_asked,
           grilled = excluded.grilled,
           seen = excluded.seen,
           quiz_correct = excluded.quiz_correct,
           quiz_total = excluded.quiz_total,
           grill_strong = excluded.grill_strong,
           grill_asked = excluded.grill_asked,
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
        grilled: item.grilled ? 1 : 0,
        seen: item.seen ? 1 : 0,
        quiz_correct: item.quizCorrect ?? 0,
        quiz_total: item.quizTotal ?? 0,
        grill_strong: item.grillStrong ?? 0,
        grill_asked: item.grillAsked ?? 0,
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
      // grilled + quiz/grill ratios are active-recall results — never
      // set/cleared by passive observation; recordQuiz/recordGrill/
      // markGrilled own them. Preserve, don't wipe.
      grilled: existing?.grilled ?? false,
      seen: existing?.seen ?? false,
      quizCorrect: existing?.quizCorrect ?? 0,
      quizTotal: existing?.quizTotal ?? 0,
      grillStrong: existing?.grillStrong ?? 0,
      grillAsked: existing?.grillAsked ?? 0,
      lastTouchedAt: now,
      lastSessionId: opts.sessionId ?? existing?.lastSessionId ?? null,
    };
    this.upsert(item);
    return item;
  }

  /** Flip the separate "passed a grill / perfect quiz" QA proof. Mirror
   *  of degrade(): requires the item to already exist (callers observe
   *  it first). Monotonic — never un-grills; independent of level. */
  markGrilled(repoPath: string, itemId: string): void {
    const existing = this.get(repoPath, itemId);
    if (!existing || existing.grilled === true) return;
    this.upsert({ ...existing, grilled: true, lastTouchedAt: new Date().toISOString() });
  }

  /** v3: the briefing's narration ACTUALLY finished playing — the real
   *  dwell signal for Seen-coverage (shown-and-played, not emitted).
   *  Monotonic. Requires the row (the briefing-delivered observe made
   *  it just before playback). */
  markSeen(repoPath: string, itemId: string): void {
    const existing = this.get(repoPath, itemId);
    if (!existing || existing.seen === true) return;
    this.upsert({ ...existing, seen: true, lastTouchedAt: new Date().toISOString() });
  }

  /** Persist the last regular-quiz result (monotonic — only keeps the
   *  best mastery ratio so a worse retake never lowers the score).
   *  Requires the item to exist (caller observes it first). */
  recordQuiz(repoPath: string, itemId: string, correct: number, total: number): void {
    const existing = this.get(repoPath, itemId);
    if (!existing || total <= 0) return;
    const prev = existing.quizTotal ? (existing.quizCorrect ?? 0) / existing.quizTotal : -1;
    if (correct / total < prev) return; // keep the best
    this.upsert({ ...existing, quizCorrect: correct, quizTotal: total, lastTouchedAt: new Date().toISOString() });
  }

  /** Persist the last grill result (monotonic best ratio). */
  recordGrill(repoPath: string, itemId: string, strong: number, asked: number): void {
    const existing = this.get(repoPath, itemId);
    if (!existing || asked <= 0) return;
    const prev = existing.grillAsked ? (existing.grillStrong ?? 0) / existing.grillAsked : -1;
    if (strong / asked < prev) return;
    this.upsert({ ...existing, grillStrong: strong, grillAsked: asked, lastTouchedAt: new Date().toISOString() });
  }

  /** Append a weak/partial question as an actionable study item.
   *  Idempotent on (repo, item, question); a re-add re-opens it. */
  addWeakSpot(repoPath: string, itemId: string, question: string, source: 'grill' | 'quiz'): void {
    this.db
      .prepare(
        `INSERT INTO weak_spots (repo_path, item_id, question, source)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_path, item_id, question)
         DO UPDATE SET resolved_at = NULL, source = excluded.source`,
      )
      .run(repoPath, itemId, question, source);
  }

  resolveWeakSpot(repoPath: string, itemId: string, question: string): void {
    this.db
      .prepare(
        `UPDATE weak_spots SET resolved_at = datetime('now')
         WHERE repo_path = ? AND item_id = ? AND question = ? AND resolved_at IS NULL`,
      )
      .run(repoPath, itemId, question);
  }

  /** Open (unresolved) weak spots. Optionally scoped to one item. */
  openWeakSpots(repoPath: string, itemId?: string): WeakSpot[] {
    const rows = itemId
      ? this.db.prepare(
          `SELECT * FROM weak_spots WHERE repo_path = ? AND item_id = ? AND resolved_at IS NULL ORDER BY created_at`,
        ).all(repoPath, itemId)
      : this.db.prepare(
          `SELECT * FROM weak_spots WHERE repo_path = ? AND resolved_at IS NULL ORDER BY created_at`,
        ).all(repoPath);
    return (rows as WeakSpotRow[]).map(rowToWeakSpot);
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

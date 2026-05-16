/** track_issue placeholder + tracker seam (B18).
 *
 * Product boundary (decided): a review tool, NOT an issue manager.
 * `track_issue`'s whole job is frictionless capture in the flow +
 * a glanceable read-only register. NO triage/edit/status UI.
 *
 * Placeholder behavior: create + persist + list LOCALLY (a follow-up
 * register on the shelf's `issues` section). External sync becomes a
 * later "flush to tracker" step, not a rewrite — hence the
 * `IssueTracker` seam with a `LocalTracker` stub now; Jira/Linear/
 * GitHub adapters slot in behind the same interface later. The skill
 * stays tracker-agnostic.
 *
 * (Code rename create_issue→track_issue stays deferred per the plan —
 * renaming a placeholder is pure churn. This adds the local-register
 * behavior the rename will eventually describe.)
 */
import type { ShelfArtifact } from '@tetherline/shared';

export interface IssueDraftLike {
  skillName?: string;
  visualPayload?: { issueTitle?: unknown; issueBody?: unknown; issueLabels?: unknown };
}

export interface TrackedIssue {
  id: string;
  title: string;
  body: string;
  labels: string[];
  /** 'local' until an external adapter syncs it. */
  state: 'local';
  createdAt: string;
}

/** The seam. LocalTracker is the only impl now; Jira/Linear/GitHub
 *  adapters implement this later WITHOUT touching the skill. */
export interface IssueTracker {
  readonly kind: string;
  create(draft: { title: string; body: string; labels: string[] }, id: string, now?: () => Date): TrackedIssue;
}

export const LocalTracker: IssueTracker = {
  kind: 'local',
  create(draft, id, now = () => new Date()): TrackedIssue {
    return {
      id,
      title: draft.title,
      body: draft.body,
      labels: draft.labels,
      state: 'local',
      createdAt: now().toISOString(),
    };
  },
};

/** Map a create_issue skill result → a TrackedIssue via the tracker.
 *  Returns null for any non-issue result. Pure (given tracker+id). */
export function trackIssueFromResult(
  r: IssueDraftLike | null | undefined,
  id: string,
  tracker: IssueTracker = LocalTracker,
  now: () => Date = () => new Date(),
): TrackedIssue | null {
  if (!r || r.skillName !== 'create_issue') return null;
  const title =
    typeof r.visualPayload?.issueTitle === 'string' && r.visualPayload.issueTitle.trim()
      ? r.visualPayload.issueTitle
      : 'Untitled follow-up';
  const body = typeof r.visualPayload?.issueBody === 'string' ? r.visualPayload.issueBody : '';
  const labels = Array.isArray(r.visualPayload?.issueLabels)
    ? (r.visualPayload!.issueLabels as unknown[]).filter((l): l is string => typeof l === 'string')
    : [];
  return tracker.create({ title, body, labels }, id, now);
}

/** TrackedIssue → a read-only shelf row (issues section). */
export function trackedIssueToShelfArtifact(issue: TrackedIssue): ShelfArtifact {
  return {
    id: issue.id,
    section: 'issues',
    summary: issue.title,
    detail: issue.labels.length ? issue.labels.join(', ') : undefined,
    state: issue.state,
    createdAt: issue.createdAt,
  };
}

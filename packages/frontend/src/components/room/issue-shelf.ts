/** create_issue → Issues shelf row (B18), frontend-side & pure.
 *
 * Mirrors annotate-shelf.ts. The backend issue-tracker.ts owns the
 * IssueTracker seam (Jira/Linear/GitHub adapters later); the frontend
 * only needs to turn a create_issue skill result into a read-only
 * Issues-section row. Kept here (not imported from backend) so the
 * frontend never depends on backend source.
 *
 * Product boundary: a glanceable read-only register, NOT a manager —
 * no edit/triage, just capture + list. State is 'local' until an
 * external adapter syncs it.
 */
import type { ShelfArtifact } from '@tetherline/shared';

export interface IssueResult {
  skillName?: string;
  visualPayload?: { issueTitle?: unknown; issueBody?: unknown; issueLabels?: unknown };
}

export function issueResultToShelfArtifact(
  r: IssueResult | null | undefined,
  id: string,
  now: () => Date = () => new Date(),
): ShelfArtifact | null {
  if (!r || r.skillName !== 'create_issue') return null;
  const title =
    typeof r.visualPayload?.issueTitle === 'string' && r.visualPayload.issueTitle.trim()
      ? r.visualPayload.issueTitle
      : 'Untitled follow-up';
  const labels = Array.isArray(r.visualPayload?.issueLabels)
    ? (r.visualPayload!.issueLabels as unknown[]).filter((l): l is string => typeof l === 'string')
    : [];
  return {
    id,
    section: 'issues',
    summary: title,
    detail: labels.length ? labels.join(', ') : undefined,
    state: 'local',
    createdAt: now().toISOString(),
  };
}

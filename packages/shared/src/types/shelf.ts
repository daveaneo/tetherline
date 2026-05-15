/** The non-blocking review shelf (B9).
 *
 * One surface, typed sections. Artifacts produced asynchronously
 * (annotations, finished deep-dives, agent tasks, tracked issues,
 * comprehension logs) ACCUMULATE here and are reviewed when the user
 * chooses — they NEVER barge into the voice conversation. The shelf
 * is bound by the product north star: the conversation is never
 * preempted; the shelf + a quiet notification is the only channel. */

export type ShelfSection =
  | 'notes' // annotate → Notebook
  | 'deep-dives' // deep_dive station index
  | 'tasks' // async agent task tray
  | 'issues' // track_issue register
  | 'comprehension'; // grill comprehension logs

export const SHELF_SECTIONS: ShelfSection[] = [
  'notes',
  'deep-dives',
  'tasks',
  'issues',
  'comprehension',
];

export interface ShelfArtifact {
  id: string;
  section: ShelfSection;
  /** One-line glanceable summary for the row. */
  summary: string;
  /** Optional richer body shown on expand. */
  detail?: string;
  /** Optional node id this links back to (click → DESCEND). */
  nodeId?: string;
  /** Optional state pill (e.g. issue: open/closed; task: running/done). */
  state?: string;
  createdAt: string;
}

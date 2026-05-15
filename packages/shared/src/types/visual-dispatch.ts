/** Shared contract for the visual dispatcher.
 *
 *  Skills never own visuals. They hand a free-form `target` to the
 *  shared dispatcher, which deterministically resolves it to a node
 *  and classifies the navigational *relationship* between the current
 *  view and the target. The relationship drives the transition the
 *  diagram plays (see the transition grammar in
 *  docs/VISUAL-COMPANION-PLAN.md). No LLM is used for routing — only
 *  GENERATE (target has no node anywhere) needs a generative call,
 *  made downstream, not here. */

export type VisualTransition =
  | 'IN_PLACE' // target == current scope — overlay/pulse only
  | 'DESCEND' // target is a node within the current set — zoom in
  | 'ASCEND' // target is an ancestor of the current scope — zoom out
  | 'LATERAL' // target exists elsewhere, unrelated branch — clean cut
  | 'GENERATE'; // target has no node anywhere — synthesize a scaffold

export interface DispatchInput {
  /** Free-form target string from the skill's classified params. */
  target: string;
  /** Current diagram scope node id, or null at the root view. */
  currentScope: string | null;
  /** Every node id currently known in the diagram payload. */
  knownNodeIds: string[];
  /** Optional id→label map so we can match human phrasing to ids. */
  nodeLabels?: Record<string, string>;
  /**
   * Ancestor scope ids from root → currentScope (exclusive of
   * currentScope). Used to detect ASCEND.
   */
  navigatorAncestors?: string[];
  /**
   * Node ids that are files. A file target is ALWAYS a deeper view
   * (DESCEND), never IN_PLACE, even if currently visible
   * (user decision 2026-05-15).
   */
  fileNodeIds?: string[];
  /**
   * Every node id known anywhere in the repo's diagram model (not
   * just the current view). Lets us distinguish LATERAL (resolves
   * elsewhere) from GENERATE (resolves nowhere). Optional; without
   * it, anything not in the current set is treated as GENERATE.
   */
  globalNodeIds?: string[];
  /** id→label for the global set, same role as nodeLabels. */
  globalNodeLabels?: Record<string, string>;
}

export interface DispatchResult {
  transition: VisualTransition;
  /** Resolved node id. Undefined only for GENERATE. */
  targetNodeId?: string;
  /** Short machine reason, for trace logs and tests. */
  reason: string;
  /**
   * For a failed resolution where GENERATE is NOT wanted (navigate),
   * the closest known node id, for a graceful "did you mean Y?".
   */
  suggestion?: string;
}

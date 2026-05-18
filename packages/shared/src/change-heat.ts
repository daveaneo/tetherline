/** whats_changed heat — per diagram-node DRIFT: "how much changed here
 *  that you haven't caught up on", not raw churn. The product is about
 *  staying tethered, so the field highlights what you're now BEHIND on.
 *
 *  Per file, drift = statusWeight(status) × changeIntensity:
 *   • green  (reviewed, unchanged)            → 0   — you're current
 *   • yellow (reviewed, but changed since)    → 0.5 — going stale
 *   • red/unknown (changed, never reviewed)   → 1   — the gap
 *  Multiplying by changeIntensity means a file that didn't move
 *  contributes 0 (this is "what CHANGED that you're behind on"), and a
 *  green file that DID move still contributes 0 (you kept up — not a
 *  gap). A node = sum of its files' drift, normalised 0..1 against the
 *  hottest node so the wash has a full cold→warm range.
 *
 *  Node id conventions: `project` (root), `module/<key>`, `file/<path>`.
 *  Module↔file matching is by path segment (heuristic — repo paths are
 *  deep and module ids are logical names), documented as such. Pure +
 *  deterministic so the scene harness and unit tests pin it exactly.
 */
export interface ChangeEntry {
  filePath: string;
  changeIntensity: number;
  /** Familiarity×change status from computeHeatmap. Absent ⇒ treated
   *  as a gap (changed-and-unreviewed) when it has changed. */
  status?: 'green' | 'yellow' | 'red';
}

function statusWeight(status: ChangeEntry['status']): number {
  return status === 'green' ? 0 : status === 'yellow' ? 0.5 : 1;
}

function moduleKey(nodeId: string): string {
  return nodeId.slice(nodeId.lastIndexOf('/') + 1);
}

/** True when `filePath` belongs to the module logical key `key`
 *  (a path segment match — `key/...`, `.../key/...`, or `.../key`). */
function fileUnderModule(filePath: string, key: string): boolean {
  if (!key) return false;
  return filePath.split('/').includes(key);
}

export function changeHeatByNode(
  nodeIds: readonly string[],
  entries: readonly ChangeEntry[],
): Map<string, number> {
  const drift = (e: ChangeEntry) => statusWeight(e.status) * (e.changeIntensity || 0);
  const raw = new Map<string, number>();
  let max = 0;
  for (const id of nodeIds) {
    let v = 0;
    if (id === 'project') {
      v = entries.reduce((s, e) => s + drift(e), 0);
    } else if (id.startsWith('module/')) {
      const key = moduleKey(id);
      v = entries.reduce(
        (s, e) => s + (fileUnderModule(e.filePath, key) ? drift(e) : 0),
        0,
      );
    } else if (id.startsWith('file/')) {
      const path = id.slice('file/'.length);
      v = entries
        .filter(e => e.filePath === path || e.filePath.endsWith(`/${path}`))
        .reduce((s, e) => s + drift(e), 0);
    }
    raw.set(id, v);
    if (v > max) max = v;
  }
  const out = new Map<string, number>();
  for (const [id, v] of raw) out.set(id, max > 0 ? v / max : 0);
  return out;
}

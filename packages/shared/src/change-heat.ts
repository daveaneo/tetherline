/** whats_changed heat — per diagram-node "how much did this move this
 *  week", derived from the git heatmap (HeatmapEntry.changeIntensity =
 *  commits touching a file in the last ~30d). Pure + deterministic so
 *  the scene harness and unit tests pin it exactly.
 *
 *  Node id conventions: `project` (root), `module/<key>`, `file/<path>`.
 *  A file node takes its own file's intensity; a module node sums the
 *  intensity of every entry that lives under it; the project sums all.
 *  Module↔file matching is by path segment (heuristic — repo paths are
 *  deep and module ids are logical names), documented as such.
 *
 *  Output is normalised 0..1 against the hottest node so the wash has a
 *  full cold→warm range regardless of absolute commit counts.
 */
export interface ChangeEntry {
  filePath: string;
  changeIntensity: number;
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
  const raw = new Map<string, number>();
  let max = 0;
  for (const id of nodeIds) {
    let v = 0;
    if (id === 'project') {
      v = entries.reduce((s, e) => s + (e.changeIntensity || 0), 0);
    } else if (id.startsWith('module/')) {
      const key = moduleKey(id);
      v = entries.reduce(
        (s, e) => s + (fileUnderModule(e.filePath, key) ? e.changeIntensity || 0 : 0),
        0,
      );
    } else if (id.startsWith('file/')) {
      const path = id.slice('file/'.length);
      v = entries
        .filter(e => e.filePath === path || e.filePath.endsWith(`/${path}`))
        .reduce((s, e) => s + (e.changeIntensity || 0), 0);
    }
    raw.set(id, v);
    if (v > max) max = v;
  }
  const out = new Map<string, number>();
  for (const [id, v] of raw) out.set(id, max > 0 ? v / max : 0);
  return out;
}

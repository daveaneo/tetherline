/** Annotate → Notebook (B10), pure & testable.
 *
 * annotate is the first real shelf producer. A flag becomes a row in
 * the shelf's `notes` section (the Notebook), the flagged node gets a
 * persistent pin glyph, and "show me what I flagged" is the recall
 * lens (dim all but the pinned).
 */
import type { ShelfArtifact } from '@tetherline/shared';

export interface AnnotateResult {
  skillName?: string;
  narration?: string;
  visualPayload?: { note?: unknown; file?: unknown; areaName?: unknown };
}

/** Map an `annotate` skill result to a Notebook shelf artifact.
 *  Returns null for any non-annotate result. Pure. */
export function annotationToShelfArtifact(
  r: AnnotateResult | null | undefined,
  id: string,
  now: () => Date = () => new Date(),
): ShelfArtifact | null {
  if (!r || r.skillName !== 'annotate') return null;
  const note =
    (typeof r.visualPayload?.note === 'string' && r.visualPayload.note) ||
    r.narration ||
    'Flagged for review';
  const file =
    typeof r.visualPayload?.file === 'string' ? r.visualPayload.file : undefined;
  const area =
    typeof r.visualPayload?.areaName === 'string' ? r.visualPayload.areaName : undefined;
  return {
    id,
    section: 'notes',
    summary: note,
    detail: [file, area].filter(Boolean).join(' · ') || undefined,
    nodeId: file,
    createdAt: now().toISOString(),
  };
}

/** "show me what I flagged" → the recall lens (dim all but pinned). */
export function isRecallLensRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(show me what i (flagged|noted)|what did i flag|my flags?|what'?s flagged|my notebook|show (my )?notes?)\b/i.test(
    text.trim(),
  );
}

/** Node ids that carry a persistent pin: a node whose leaf/label
 *  matches an annotation's file/target. Deterministic, leaf-based
 *  (an interior path segment belongs to an ancestor, not the node). */
export function pinnedNodeIds(
  annotationTargets: string[],
  nodes: { id: string; label?: string }[],
): Set<string> {
  const leaf = (s: string) => s.split('/').pop()!.toLowerCase();
  const targets = annotationTargets
    .map(t => t.toLowerCase().trim())
    .filter(t => t.length >= 2);
  const pins = new Set<string>();
  for (const n of nodes) {
    const idLeaf = leaf(n.id);
    const label = (n.label ?? '').toLowerCase();
    for (const t of targets) {
      const tLeaf = leaf(t);
      if (
        idLeaf === tLeaf ||
        (label.length >= 2 && (label === tLeaf || t.includes(label))) ||
        t.includes(idLeaf)
      ) {
        pins.add(n.id);
        break;
      }
    }
  }
  return pins;
}

/** "You are here" breadcrumb (B16) — the P0 ship-blocker.
 *
 * The subway/pocket model is unusable without a persistent indicator
 * of WHERE the user is: spine position ▸ (pocket, if inside) ▸ slide
 * n/N. This is the pure builder; a tiny always-visible component
 * renders it. Deterministic.
 *
 * Rules:
 *  - Spine crumbs only when not in a pocket.
 *  - Inside a pocket the spine is shown DIMMED (you can see where
 *    you'll resurface) + the pocket focus + the slide cursor.
 *  - Never empty: at minimum the root crumb shows.
 */

export interface Crumb {
  label: string;
  /** 'spine' | 'pocket' | 'slide' — drives styling (pocket/slide are
   *  the live position; spine behind a pocket is dimmed). */
  kind: 'spine' | 'pocket' | 'slide';
  /** True when this crumb is the user's actual current position. */
  current: boolean;
}

export interface BreadcrumbInput {
  /** Root → current spine labels (e.g. ['Tetherline','Core']). */
  spine: string[];
  /** Present only when inside a deep_dive pocket. */
  pocket?: { focus?: string; slide: number; total: number };
}

export function buildBreadcrumb(input: BreadcrumbInput): Crumb[] {
  const spine = input.spine.length > 0 ? input.spine : ['Project'];
  const inPocket = !!input.pocket;

  const crumbs: Crumb[] = spine.map((label, i) => ({
    label,
    kind: 'spine',
    // The deepest spine crumb is "current" ONLY when not in a pocket;
    // inside a pocket the whole spine is the dimmed return path.
    current: !inPocket && i === spine.length - 1,
  }));

  if (input.pocket) {
    crumbs.push({
      label: input.pocket.focus?.trim() || 'deep dive',
      kind: 'pocket',
      current: false,
    });
    crumbs.push({
      label: `${Math.min(input.pocket.slide + 1, input.pocket.total)}/${input.pocket.total}`,
      kind: 'slide',
      current: true, // the live position
    });
  }
  return crumbs;
}

/** Flat string form (for aria-label / logs / tests). */
export function breadcrumbText(crumbs: Crumb[]): string {
  return crumbs.map(c => c.label).join(' ▸ ');
}

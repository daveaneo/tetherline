/** The ONLY level→colour mapping in the frontend.
 *
 * Thin adapter over the shared canonical model: maps the pure
 * heat-step index to the theme's purpose-built `--heat-0..5` oklch
 * ramp (packages/frontend/src/styles/global.css). Because it's
 * `var(--heat-${step})` with no per-level switch, it structurally
 * cannot diverge from the shared ordering — replacing the three
 * hand-maintained maps that previously drifted.
 *
 * Returns `null` for unknown/undefined to preserve the diagram's
 * "no halo when nothing is known" contract; callers supply their own
 * fallback token where a swatch must always render.
 */
import { levelHeatStep, type ComprehensionLevel } from '@tetherline/shared';

export function levelColor(level: ComprehensionLevel | undefined | null): string | null {
  if (!level || level === 'unknown') return null;
  return `var(--heat-${levelHeatStep(level)})`;
}

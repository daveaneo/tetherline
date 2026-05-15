/** Grill quiz screen (B8).
 *
 * Per the plan's grill_me decision: grilling swaps to a dedicated,
 * calm, SVG-animated `?` screen — a MODE INDICATOR, not a cleverness
 * contest. The content rides voice + HermesText; the screen just
 * says "you're in the hot seat".
 *
 * Pure activation predicate. The screen is a render overlay — it
 * never calls setScope or mutates the payload, so snapshot/restore
 * is structural: when the grill ends and a normal result returns,
 * the prior canvas is simply shown again, unchanged. (It uses the
 * snapshot/restore half of the pocket machinery, NOT a slider tick —
 * a quiz is a mode, not a rewindable turn.)
 */
export function grillScreenActive(
  skillResult: { skillName?: string } | null | undefined,
): boolean {
  return skillResult?.skillName === 'grill_me';
}

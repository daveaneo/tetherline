import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { resolveNavigation, navigateMissNarration } from './navigate-resolve.js';

export const navigateSkill: Skill = {
  name: 'navigate',
  description: 'Move to a specific part of the codebase',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.file ?? params.component ?? '';

    const res = resolveNavigation(
      target,
      context.areas.map(a => ({ id: a.id, name: a.name, affectedFiles: a.affectedFiles })),
    );

    if (res.kind === 'hit') {
      // Visual-primary: a one-liner ack, then silence — the move IS
      // the response. The transition (DESCEND/ASCEND/LATERAL) is
      // decided client-side from the scope change (B2).
      return {
        skillName: 'navigate',
        type: 'diagram',
        narration: `Here's ${res.areaName}.`,
        visualPayload: { target, areaId: res.areaId },
        diagramChanges: { focusNodeId: res.areaId },
      };
    }

    // Miss → graceful fuzzy fail. NEVER invent a place (no GENERATE).
    return {
      skillName: 'navigate',
      type: 'diagram',
      narration: navigateMissNarration(target, res.suggestion),
      visualPayload: { target, miss: true, suggestion: res.suggestion },
    };
  },
};

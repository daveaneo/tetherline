import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@interactive-reviewer/shared';

export const navigateSkill: Skill = {
  name: 'navigate',
  description: 'Move to a specific part of the codebase',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.file ?? params.component ?? '';

    // Try to find a matching area or node
    const matchingArea = context.areas.find(a =>
      a.name.toLowerCase().includes(target.toLowerCase()) ||
      a.affectedFiles.some(f => f.toLowerCase().includes(target.toLowerCase()))
    );

    const narration = matchingArea
      ? `Moving to ${matchingArea.name}.`
      : `Looking for ${target} in the codebase.`;

    return {
      skillName: 'navigate',
      type: 'diagram',
      narration,
      visualPayload: { target, areaId: matchingArea?.id },
      diagramChanges: matchingArea ? { focusNodeId: matchingArea.id } : undefined,
    };
  },
};

import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@interactive-reviewer/shared';

export const annotateSkill: Skill = {
  name: 'annotate',
  description: 'Create a persistent note or flag for later',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const note = params.note ?? params.target ?? 'Flagged for review';
    const file = params.file ?? context.currentFile;

    return {
      skillName: 'annotate',
      type: 'annotation',
      narration: `Noted: "${note}"${file ? ` on ${file}` : ''}. I'll remember this for next time.`,
      visualPayload: { note, file, areaName: context.currentArea?.name },
    };
  },
};

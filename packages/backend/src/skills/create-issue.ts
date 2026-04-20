import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { buildIssuePrompt, ISSUE_TOOL, type IssueDraft } from '../intelligence/prompts/issue.js';

export const createIssueSkill: Skill = {
  name: 'create_issue',
  description: 'Draft a GitHub issue from the current review context',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const area = context.currentArea;

    const prompt = buildIssuePrompt({
      areaName: area?.name,
      areaDescription: area?.description,
      userDescription: params.description ?? params.target,
      affectedFiles: area?.affectedFiles,
      commitHashes: area?.commitHashes,
    });

    let draft: IssueDraft;
    try {
      draft = await context.analyzer.structuredCallDirect<IssueDraft>({
        prompt,
        toolName: ISSUE_TOOL.name,
        toolDescription: ISSUE_TOOL.description,
        inputSchema: ISSUE_TOOL.inputSchema,
      });
    } catch {
      draft = {
        title: `Review: ${area?.name ?? 'Code review finding'}`,
        body: `Found during interactive review.\n\n${params.description ?? area?.description ?? ''}`,
        labels: [],
      };
    }

    return {
      skillName: 'create_issue',
      type: 'explanation', // rendered as a preview card
      narration: `I've drafted an issue: "${draft.title}". Take a look and let me know if you'd like to adjust anything.`,
      visualPayload: {
        action: 'issue_preview',
        issueTitle: draft.title,
        issueBody: draft.body,
        issueLabels: draft.labels,
      },
    };
  },
};

export function buildIssuePrompt(context: {
  areaName?: string;
  areaDescription?: string;
  userDescription?: string;
  narrationContext?: string;
  affectedFiles?: string[];
  commitHashes?: string[];
}): string {
  return `Draft a GitHub issue based on this code review context. Generate a concise title and a clear, actionable body in markdown.

${context.areaName ? `Area: ${context.areaName}` : ''}
${context.areaDescription ? `Description: ${context.areaDescription}` : ''}
${context.userDescription ? `User's note: ${context.userDescription}` : ''}
${context.narrationContext ? `Review context: ${context.narrationContext}` : ''}
${context.affectedFiles?.length ? `Affected files:\n${context.affectedFiles.slice(0, 10).join('\n')}` : ''}
${context.commitHashes?.length ? `Related commits: ${context.commitHashes.slice(0, 5).join(', ')}` : ''}

The body should include:
- A clear description of the issue/improvement
- Affected files (as a checklist)
- Related commits if relevant
- Suggested approach if obvious

Keep the title under 80 characters. Keep the body concise but complete.`;
}

export const ISSUE_TOOL = {
  name: 'draft_issue',
  description: 'Draft a GitHub issue',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Issue title (under 80 chars)' },
      body: { type: 'string', description: 'Issue body in markdown' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Suggested labels' },
    },
    required: ['title', 'body'],
  },
};

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

import type { CommitDiff } from '@interactive-reviewer/shared';

export function buildConcernsPrompt(diffs: CommitDiff[]): string {
  const diffSummaries = diffs.map(d => ({
    commit: d.commit.shortHash + ': ' + d.commit.message,
    files: d.fileDiffs.map(fd => ({
      path: fd.path,
      diff: fd.hunks.map(h => h.content).join('\n').slice(0, 2000),
    })),
  }));

  return `Review these code changes and identify any concerns. Look for:

1. **Security** — vulnerabilities, exposed secrets, missing auth checks, injection risks
2. **Breaking changes** — API changes, removed exports, schema migrations without rollback
3. **Missing tests** — significant logic changes without corresponding test changes
4. **Performance** — N+1 queries, unbounded loops, memory leaks, missing pagination
5. **Patterns** — inconsistencies with existing codebase patterns, duplicate implementations

Only flag genuine concerns — not style preferences. For each concern, be specific about which code and why it's a problem.

If there are no real concerns, return an empty array. Don't manufacture problems.

Changes:
${JSON.stringify(diffSummaries, null, 2)}`;
}

export const CONCERNS_TOOL = {
  name: 'flag_concerns',
  description: 'Flag code quality and security concerns in the changes',
  inputSchema: {
    type: 'object' as const,
    properties: {
      concerns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: {
              type: 'string',
              enum: ['info', 'warning', 'critical'],
            },
            category: {
              type: 'string',
              enum: ['security', 'breaking_change', 'missing_tests', 'performance', 'pattern', 'other'],
            },
            title: { type: 'string', description: 'One-line title' },
            description: {
              type: 'string',
              description: 'Detailed explanation of the concern and suggested fix',
            },
            affectedFiles: { type: 'array', items: { type: 'string' } },
            commitHashes: { type: 'array', items: { type: 'string' } },
          },
          required: ['severity', 'category', 'title', 'description', 'affectedFiles', 'commitHashes'],
        },
      },
    },
    required: ['concerns'],
  },
};

export interface ConcernsResult {
  concerns: Array<{
    severity: 'info' | 'warning' | 'critical';
    category: 'security' | 'breaking_change' | 'missing_tests' | 'performance' | 'pattern' | 'other';
    title: string;
    description: string;
    affectedFiles: string[];
    commitHashes: string[];
  }>;
}

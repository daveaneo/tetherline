import type { CommitDiff } from '@tetherline/shared';

export function buildClusteringPrompt(commits: CommitDiff[]): string {
  const summaries = commits.map(c => ({
    hash: c.commit.shortHash,
    message: c.commit.message,
    author: c.commit.author,
    files: c.fileDiffs.map(fd => fd.path),
    linesChanged: c.fileDiffs.reduce(
      (sum, fd) => sum + fd.hunks.reduce((s, h) => s + h.content.split('\n').length, 0),
      0,
    ),
  }));

  return `Group these ${commits.length} commits into logical areas of change (features, bug fixes, refactors, infrastructure, etc.).

Each area should have:
- A clear, descriptive name (e.g., "Authentication refactor", "Payment flow bug fixes")
- A one-paragraph description of what changed and why
- The list of commit hashes that belong to it
- A significance rating: "major" (new features, architectural changes), "minor" (enhancements, moderate fixes), or "maintenance" (dependency updates, formatting, small fixes)

For each area, also provide a "theme" — a high-level category like "Security", "Performance", "Data model", "Testing", "DevOps", "UI/UX", "API", or "Documentation".

Commits that touch the same files or relate to the same feature should be grouped together. A commit can belong to multiple areas if it spans concerns, but prefer assigning each commit to its primary area.

Commits:
${JSON.stringify(summaries, null, 2)}`;
}

export const CLUSTERING_TOOL = {
  name: 'group_commits',
  description: 'Group commits into semantic areas of change',
  inputSchema: {
    type: 'object' as const,
    properties: {
      areas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Descriptive name for this area of change' },
            description: { type: 'string', description: 'One paragraph explaining what changed and why' },
            commitHashes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Short hashes of commits in this area',
            },
            significance: {
              type: 'string',
              enum: ['major', 'minor', 'maintenance'],
              description: 'Impact level',
            },
            theme: {
              type: 'string',
              description: 'High-level category: Security, Performance, Data model, Testing, DevOps, UI/UX, API, Documentation, or similar',
            },
          },
          required: ['name', 'description', 'commitHashes', 'significance', 'theme'],
        },
      },
    },
    required: ['areas'],
  },
};

export interface ClusteringResult {
  areas: Array<{
    name: string;
    description: string;
    commitHashes: string[];
    significance: 'major' | 'minor' | 'maintenance';
    theme: string;
  }>;
}

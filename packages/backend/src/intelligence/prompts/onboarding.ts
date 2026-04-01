export function buildOnboardingPrompt(context: {
  repoName: string;
  languages: string[];
  fileTree: string[];
  areaNames: string[];
  totalFiles: number;
}): string {
  return `Design a 5-day onboarding program for a developer who is new to this codebase. Each day should progressively deepen understanding.

Day 1: Project overview — what it does, who it's for, key concepts (visual layer: overview card)
Day 2: Architecture — how the main pieces connect, data flow (visual layer: conceptual flow + architecture diagram)
Day 3: Key components part 1 — the most important 2-3 modules in depth (visual layer: component zoom)
Day 4: Key components part 2 — remaining important modules (visual layer: component zoom)
Day 5: Code patterns — conventions, testing approach, common patterns (visual layer: code view)

Project: ${context.repoName}
Languages: ${context.languages.join(', ')}
Files: ${context.totalFiles}
Key areas: ${context.areaNames.join(', ')}

File structure (first 100):
${context.fileTree.slice(0, 100).join('\n')}

For each day, provide: title, description (2-3 sentences), a list of 3-5 specific topics to cover, and estimated minutes (10-30).`;
}

export const ONBOARDING_TOOL = {
  name: 'onboarding_program',
  description: 'Generate a 5-day onboarding program',
  inputSchema: {
    type: 'object' as const,
    properties: {
      days: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dayNumber: { type: 'number' },
            title: { type: 'string' },
            description: { type: 'string' },
            topics: { type: 'array', items: { type: 'string' } },
            estimatedMinutes: { type: 'number' },
          },
          required: ['dayNumber', 'title', 'description', 'topics', 'estimatedMinutes'],
        },
      },
    },
    required: ['days'],
  },
};

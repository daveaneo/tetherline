export function buildQuietWeekPrompt(repoName: string, weakAreas: Array<{ name: string; percentage: number }>): string {
  return `The codebase "${repoName}" hasn't changed since the last review. Suggest what the user should explore based on their weakest understanding areas. Be conversational — this will be spoken aloud.

Areas the user understands least:
${weakAreas.map(a => `- ${a.name}: ${a.percentage}% understood`).join('\n')}

Generate a brief, friendly suggestion (2-3 sentences).`;
}

export const QUIET_WEEK_TOOL = {
  name: 'quiet_week_suggestion',
  description: 'Generate a suggestion for what to explore when nothing has changed',
  inputSchema: {
    type: 'object' as const,
    properties: {
      suggestion: { type: 'string', description: 'A conversational suggestion (2-3 sentences)' },
      suggestedAreaNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of the weakest areas to suggest exploring',
      },
    },
    required: ['suggestion', 'suggestedAreaNames'],
  },
};

export interface QuietWeekResult {
  suggestion: string;
  suggestedAreaNames: string[];
}

export function buildProjectOverviewPrompt(context: {
  repoName: string;
  fileTree: string[];
  readmeContent?: string;
  packageJsonContent?: string;
  languages: string[];
  totalFiles: number;
  totalCommits: number;
}): string {
  return `Generate a narration script introducing this project for the first time. This will be spoken aloud via TTS to a developer who has never seen this codebase.

Cover:
1. What does this project do? (infer from README, package.json, and file structure)
2. What technologies and frameworks does it use?
3. How is the codebase organized at a high level?
4. What are the most important areas a developer should understand?

Keep it conversational and natural — this is narrated, not written. About 4-6 sentences.

Project: ${context.repoName}
Languages: ${context.languages.join(', ')}
Total files: ${context.totalFiles}
Total commits: ${context.totalCommits}

${context.readmeContent ? `README:\n${context.readmeContent.slice(0, 3000)}` : 'No README found.'}

${context.packageJsonContent ? `package.json:\n${context.packageJsonContent.slice(0, 1500)}` : ''}

File tree (top 200 entries):
${context.fileTree.slice(0, 200).join('\n')}`;
}

export const PROJECT_OVERVIEW_TOOL = {
  name: 'project_overview',
  description: 'Generate a project overview narration',
  inputSchema: {
    type: 'object' as const,
    properties: {
      overview: { type: 'string', description: 'The narration text (4-6 conversational sentences)' },
      purpose: { type: 'string', description: 'One sentence: what the project does' },
      techStack: { type: 'array', items: { type: 'string' }, description: 'Key technologies used' },
      keyAreas: { type: 'array', items: { type: 'string' }, description: 'Most important areas to understand' },
    },
    required: ['overview', 'purpose', 'techStack', 'keyAreas'],
  },
};

export interface ProjectOverviewResult {
  overview: string;
  purpose: string;
  techStack: string[];
  keyAreas: string[];
}

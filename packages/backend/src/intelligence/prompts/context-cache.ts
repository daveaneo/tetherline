export function buildModuleDetectionPrompt(fileTree: string[], readmeSections: string[], manifestName: string): string {
  return `Identify the logical modules in this project. A module is a cohesive group of files that serve a single purpose (e.g., "API routes", "database layer", "authentication", "UI components").

Project: ${manifestName}
README sections found: ${readmeSections.join(', ') || 'none'}

File tree (first 300 entries):
${fileTree.slice(0, 300).join('\n')}

Group these files into 5-15 logical modules. For each module, give a short name and list the file path prefixes that belong to it.`;
}

export const MODULE_DETECTION_TOOL = {
  name: 'detect_modules',
  description: 'Identify logical modules in a codebase',
  inputSchema: {
    type: 'object' as const,
    properties: {
      modules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short module name' },
            pathPrefixes: { type: 'array', items: { type: 'string' }, description: 'File path prefixes belonging to this module' },
            description: { type: 'string', description: 'One sentence: what this module does' },
          },
          required: ['name', 'pathPrefixes', 'description'],
        },
      },
    },
    required: ['modules'],
  },
};

export function buildModuleSummaryPrompt(moduleName: string, fileSummaries: string[], readmeContent?: string): string {
  return `Summarize this module in one paragraph. What does it do, what are its key files, and what does it depend on?

Module: ${moduleName}
${readmeContent ? `README says: ${readmeContent}` : ''}

Files in this module:
${fileSummaries.join('\n')}`;
}

export function buildProjectSynthesisPrompt(
  repoName: string,
  readmePurpose: string,
  manifestDesc: string,
  techStack: string[],
  moduleSummaries: string[],
): string {
  return `Synthesize a one-paragraph project summary from these sources. Be concise and accurate.

Project: ${repoName}
${readmePurpose ? `README says: ${readmePurpose}` : ''}
${manifestDesc ? `Manifest says: ${manifestDesc}` : ''}
Tech stack: ${techStack.join(', ') || 'unknown'}

Modules:
${moduleSummaries.join('\n\n')}`;
}

export function buildFileBatchSummaryPrompt(files: Array<{ path: string; snippet: string }>): string {
  return `Summarize each file in exactly one sentence. Focus on what it does, not how.

${files.map((f, i) => `--- File ${i + 1}: ${f.path} ---\n${f.snippet}`).join('\n\n')}`;
}

export const FILE_BATCH_TOOL = {
  name: 'summarize_files',
  description: 'Summarize multiple files',
  inputSchema: {
    type: 'object' as const,
    properties: {
      summaries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'number' },
            summary: { type: 'string', description: 'One sentence summary' },
            role: { type: 'string', enum: ['entry', 'utility', 'config', 'test', 'type', 'model', 'route', 'component', 'other'] },
          },
          required: ['index', 'summary', 'role'],
        },
      },
    },
    required: ['summaries'],
  },
};

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
  return `Write a substantive summary of this module that a developer would actually find useful. The summary will be spoken aloud as part of a guided code-review tour.

REQUIRED — your summary must include all three:
1. The central concept the module owns (one sentence — the thing that, if you understood nothing else, would orient you).
2. A non-obvious detail or surprise: a constraint, an edge case, a "but actually" that a reader exploring just the directory listing would miss.
3. A specific file (by name) that does the heaviest lifting and what it owns. Use the actual file name from the list below.

Forbidden:
- No filler ("This module handles…", "Various utilities for…").
- No marketing language.
- Don't enumerate every file. Three at most, only if each does something meaningfully different.
- Don't end with "…and helpers" or "…and tests" — be specific or omit.

Length: 3–4 sentences total. Conversational tone (it's spoken, not read).

Module: ${moduleName}
${readmeContent ? `README says: ${readmeContent}` : ''}

Files in this module (with one-line summaries):
${fileSummaries.join('\n')}`;
}

export function buildProjectSynthesisPrompt(
  repoName: string,
  readmePurpose: string,
  manifestDesc: string,
  techStack: string[],
  moduleSummaries: string[],
): string {
  return `Write the project briefing a senior engineer would want before they touch this codebase. The briefing will be spoken aloud as the first thing the user hears.

REQUIRED — your summary must include:
1. What the product DOES, in one sentence — phrased so a non-team-member instantly gets it.
2. The architectural shape — the 2–3 worlds (e.g. "backend, frontend, shared types") and what each one owns.
3. The thing that's NOT obvious from the file tree — a constraint, a design choice with consequences, the gravity (where activity concentrates), the "watch out for…" detail. This is the line that makes the briefing feel like a real human guide, not a directory listing.

Forbidden:
- "This is a project that…" or any other filler opener.
- Listing modules without saying what they own.
- Marketing language.
- Generic descriptors that could apply to any codebase ("modular architecture", "robust logging").

Length: 4–6 sentences. Conversational tone (spoken aloud).

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

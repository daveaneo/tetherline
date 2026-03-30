export function buildArchitecturePrompt(
  fileTree: string[],
  areas: Array<{ name: string; affectedFiles: string[] }>,
): string {
  return `Analyze this project's file structure and generate an architecture diagram as a graph of modules/components.

Each node should represent a logical module or component (not individual files — group related files). Each edge represents a dependency or relationship between modules.

For each node, provide:
- id: a unique identifier (kebab-case)
- label: human-readable name
- type: "module" (directory/package), "file" (important standalone file), or "area" (a changed area)
- filePath: the primary directory or file this node represents

For each edge, provide:
- source and target node IDs
- type: "dependency", "import", or "call"

Focus on the most important ~15-25 nodes. Don't include every file — group them logically.

File tree:
${fileTree.slice(0, 500).join('\n')}
${fileTree.length > 500 ? `\n... (${fileTree.length - 500} more files)` : ''}

Recently changed areas:
${areas.map(a => `- ${a.name}: ${a.affectedFiles.slice(0, 10).join(', ')}${a.affectedFiles.length > 10 ? ` (+${a.affectedFiles.length - 10} more)` : ''}`).join('\n')}`;
}

export const ARCHITECTURE_TOOL = {
  name: 'architecture_graph',
  description: 'Generate an architecture diagram as a node-edge graph',
  inputSchema: {
    type: 'object' as const,
    properties: {
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['module', 'file', 'area'] },
            filePath: { type: 'string' },
          },
          required: ['id', 'label', 'type'],
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            target: { type: 'string' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['dependency', 'import', 'call'] },
          },
          required: ['source', 'target', 'type'],
        },
      },
    },
    required: ['nodes', 'edges'],
  },
};

export interface ArchitectureResult {
  nodes: Array<{
    id: string;
    label: string;
    type: 'module' | 'file' | 'area';
    filePath?: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label?: string;
    type: 'dependency' | 'import' | 'call';
  }>;
}

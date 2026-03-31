export function buildArchitecturePrompt(
  fileTree: string[],
  areas: Array<{ name: string; affectedFiles: string[] }>,
): string {
  return `Analyze this project's file structure and generate a HIERARCHICAL architecture diagram with three zoom levels.

Create nodes at three levels of detail with STRICT limits:
- Level 1: max 8 nodes. Top-level modules/packages (e.g., "frontend", "backend", "shared", "database")
- Level 2: max 15 children per Level 1 node. Sub-modules within each L1 node. Set parentId to the L1 node's id.
- Level 3: max 10 files per Level 2 node. Key files within each L2 sub-module. Set parentId to the L2 node's id.

HARD LIMIT: Total max ~50 nodes. If the project is large, prioritize the most important modules and recently changed areas. Omit less significant files rather than exceeding the limit.

For each node, provide:
- id: a unique identifier (kebab-case)
- label: human-readable name
- type: "module" (directory/package), "file" (important standalone file), or "area" (a changed area)
- filePath: the primary directory or file this node represents
- parentId: the id of the parent node (omit for Level 1 nodes)
- zoomLevel: 1, 2, or 3

For each edge, provide:
- source and target node IDs
- type: "dependency", "import", or "call"

Edges should connect nodes at any level. Prefer edges between nodes at the same zoom level when possible.

File tree:
${fileTree.slice(0, 500).join('\n')}
${fileTree.length > 500 ? `\n... (${fileTree.length - 500} more files)` : ''}

Recently changed areas:
${areas.map(a => `- ${a.name}: ${a.affectedFiles.slice(0, 10).join(', ')}${a.affectedFiles.length > 10 ? ` (+${a.affectedFiles.length - 10} more)` : ''}`).join('\n')}`;
}

export const ARCHITECTURE_TOOL = {
  name: 'architecture_graph',
  description: 'Generate a hierarchical architecture diagram as a node-edge graph with three zoom levels',
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
            parentId: { type: 'string', description: 'ID of the parent node (omit for Level 1 nodes)' },
            zoomLevel: { type: 'number', enum: [1, 2, 3], description: 'Hierarchy level: 1=top, 2=sub-module, 3=file' },
          },
          required: ['id', 'label', 'type', 'zoomLevel'],
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
    parentId?: string;
    zoomLevel: 1 | 2 | 3;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label?: string;
    type: 'dependency' | 'import' | 'call';
  }>;
}

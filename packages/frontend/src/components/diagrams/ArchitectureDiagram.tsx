import { useMemo, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { DiagramNode, DiagramEdge } from '@interactive-reviewer/shared';
import { ModuleNode, type ModuleNodeType } from './nodes/ModuleNode.js';

interface Props {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  focusedNodeId?: string;
  highlightedFiles?: string[];
}

// Simple tree layout algorithm (no dagre dependency needed)
function layoutNodes(nodes: DiagramNode[], edges: DiagramEdge[]): ModuleNodeType[] {
  // Build adjacency for topological sort
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();

  for (const node of nodes) {
    children.set(node.id, []);
    parents.set(node.id, []);
  }
  for (const edge of edges) {
    children.get(edge.source)?.push(edge.target);
    parents.get(edge.target)?.push(edge.source);
  }

  // Find roots (no parents)
  const roots = nodes.filter(n => (parents.get(n.id)?.length ?? 0) === 0);

  // BFS level assignment
  const levels = new Map<string, number>();
  const queue = roots.map(r => r.id);
  for (const id of queue) levels.set(id, 0);

  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    const level = levels.get(current) ?? 0;
    for (const child of children.get(current) ?? []) {
      if (!levels.has(child)) {
        levels.set(child, level + 1);
        queue.push(child);
      }
    }
  }

  // Assign positions by level
  const levelCounts = new Map<number, number>();

  return nodes.map(node => {
    const level = levels.get(node.id) ?? 0;
    const count = levelCounts.get(level) ?? 0;
    levelCounts.set(level, count + 1);

    return {
      id: node.id,
      type: 'module' as const,
      position: { x: count * 280, y: level * 180 },
      data: {
        label: node.label,
        nodeType: node.type,
        filePath: node.filePath,
        focused: false,
        highlighted: false,
      },
    };
  });
}

function convertEdges(edges: DiagramEdge[]): Edge[] {
  return edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: 'smoothstep',
    animated: edge.type === 'call',
    style: { stroke: '#4a4a6a', strokeWidth: 1.5 },
    labelStyle: { fill: '#8888a0', fontSize: 11 },
  }));
}

const nodeTypes: NodeTypes = {
  module: ModuleNode,
};

export function ArchitectureDiagram({ nodes: rawNodes, edges: rawEdges, focusedNodeId, highlightedFiles }: Props) {
  const initialNodes = useMemo(() => layoutNodes(rawNodes, rawEdges), [rawNodes, rawEdges]);
  const initialEdges = useMemo(() => convertEdges(rawEdges), [rawEdges]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  // Update focus/highlight when they change
  useEffect(() => {
    setNodes(nds => nds.map(n => ({
      ...n,
      data: {
        ...n.data,
        focused: n.id === focusedNodeId,
        highlighted: highlightedFiles?.some(f => n.data.filePath != null && f.includes(String(n.data.filePath))) ?? false,
      },
    })));
  }, [focusedNodeId, highlightedFiles, setNodes]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#2a2a3a" gap={20} />
        <Controls
          style={{
            background: '#12121a',
            borderColor: '#2a2a3a',
            borderRadius: '8px',
          }}
        />
      </ReactFlow>
    </div>
  );
}

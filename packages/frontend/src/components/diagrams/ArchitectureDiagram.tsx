import { useCallback, useMemo, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { DiagramNode, DiagramEdge } from '@tetherline/shared';
import { ModuleNode } from './nodes/ModuleNode.js';

const elk = new ELK();

interface Props {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  focusedNodeId?: string;
  highlightedFiles?: string[];
}

async function layoutWithElk(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  collapsedIds: Set<string>,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  // Filter to visible nodes (not children of collapsed parents)
  const visibleNodes = nodes.filter(n => {
    if (!n.parentId) return true; // top-level always visible
    // Walk up the parent chain -- if any ancestor is collapsed, hide this node
    let current = n;
    while (current.parentId) {
      if (collapsedIds.has(current.parentId)) return false;
      const parent = nodes.find(p => p.id === current.parentId);
      if (!parent) break;
      current = parent;
    }
    return true;
  });

  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleEdges = edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.padding': '[top=30,left=30,bottom=30,right=30]',
    },
    children: visibleNodes.map(n => ({
      id: n.id,
      width: n.type === 'file' ? 160 : 200,
      height: n.type === 'file' ? 50 : 70,
    })),
    edges: visibleEdges.map(e => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const layout = await elk.layout(elkGraph);

  const layoutNodes: Node[] = (layout.children ?? []).map(elkNode => {
    const original = visibleNodes.find(n => n.id === elkNode.id)!;
    const hasChildren = nodes.some(n => n.parentId === original.id);
    const isCollapsed = collapsedIds.has(original.id);

    return {
      id: original.id,
      type: 'module',
      position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
      data: {
        label: original.label,
        nodeType: original.type,
        filePath: original.filePath,
        zoomLevel: original.zoomLevel,
        focused: false,
        highlighted: false,
        hasChildren,
        collapsed: isCollapsed,
      },
    };
  });

  const layoutEdges: Edge[] = visibleEdges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: 'smoothstep',
    animated: edge.type === 'call',
    style: { stroke: '#4a4a6a', strokeWidth: 1.5 },
    labelStyle: { fill: '#8888a0', fontSize: 11 },
  }));

  return { nodes: layoutNodes, edges: layoutEdges };
}

function DiagramInner({ nodes: rawNodes, edges: rawEdges, focusedNodeId, highlightedFiles }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    // Initially collapse everything -- show only level 1
    const ids = new Set<string>();
    for (const n of rawNodes) {
      if (n.zoomLevel === 1) {
        ids.add(n.id);
      }
    }
    return ids;
  });
  const { fitView } = useReactFlow();

  // Layout when nodes/edges/collapsed state changes
  useEffect(() => {
    if (rawNodes.length === 0) return;
    layoutWithElk(rawNodes, rawEdges, collapsedIds).then(({ nodes: ln, edges: le }) => {
      setNodes(ln);
      setEdges(le);
      setTimeout(() => fitView({ duration: 400, padding: 0.2 }), 50);
    });
  }, [rawNodes, rawEdges, collapsedIds, setNodes, setEdges, fitView]);

  // Update focus/highlight
  useEffect(() => {
    setNodes(nds => nds.map(n => ({
      ...n,
      data: {
        ...n.data,
        focused: n.id === focusedNodeId,
        highlighted: highlightedFiles?.some(f => {
          const fp = n.data.filePath as string | undefined;
          return fp && f.includes(fp);
        }) ?? false,
      },
    })));
  }, [focusedNodeId, highlightedFiles, setNodes]);

  // Focus on a specific node when focusedNodeId changes
  useEffect(() => {
    if (focusedNodeId) {
      fitView({ nodes: [{ id: focusedNodeId }], duration: 600, padding: 0.5 });
    }
  }, [focusedNodeId, fitView]);

  // Handle expand/collapse
  const onToggleCollapse = useCallback((nodeId: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const nodeTypes: NodeTypes = useMemo(() => ({
    module: (props: any) => <ModuleNode {...props} onToggleCollapse={onToggleCollapse} />,
  }), [onToggleCollapse]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.2}
      maxZoom={2.5}
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
  );
}

export function ArchitectureDiagram(props: Props) {
  return (
    <ReactFlowProvider>
      <DiagramInner {...props} />
    </ReactFlowProvider>
  );
}

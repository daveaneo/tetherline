import { Handle, Position, type NodeProps } from '@xyflow/react';
import { motion } from 'framer-motion';

interface ModuleNodeData {
  label: string;
  nodeType: 'module' | 'file' | 'area';
  filePath?: string;
  zoomLevel: 1 | 2 | 3;
  focused: boolean;
  highlighted: boolean;
  hasChildren: boolean;
  collapsed: boolean;
}

interface ModuleNodeProps extends NodeProps {
  onToggleCollapse?: (nodeId: string) => void;
}

export function ModuleNode({ id, data, onToggleCollapse }: ModuleNodeProps) {
  const { label, nodeType, zoomLevel, focused, highlighted, hasChildren, collapsed } = data as unknown as ModuleNodeData;

  const sizeClass = zoomLevel === 1
    ? 'min-w-[180px] px-5 py-4'
    : zoomLevel === 2
    ? 'min-w-[150px] px-4 py-3'
    : 'min-w-[130px] px-3 py-2';

  const labelSize = zoomLevel === 1 ? 'text-sm font-semibold' : zoomLevel === 2 ? 'text-xs font-medium' : 'text-xs';

  return (
    <motion.div
      animate={{
        scale: focused ? 1.1 : 1,
        boxShadow: focused
          ? '0 0 24px rgba(99, 102, 241, 0.5)'
          : highlighted
          ? '0 0 16px rgba(52, 211, 153, 0.3)'
          : '0 0 0px transparent',
      }}
      transition={{ duration: 0.3 }}
      className={`rounded-xl border-2 text-center transition-colors cursor-pointer ${sizeClass} ${
        focused
          ? 'bg-[#1e1e3a] border-[var(--color-accent)]'
          : highlighted
          ? 'bg-[#1a2a1a] border-[var(--color-green)]'
          : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:border-[var(--color-accent)]/50'
      }`}
      onClick={() => {
        if (hasChildren && onToggleCollapse) {
          onToggleCollapse(id);
        }
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-[var(--color-border)] !w-2 !h-2" />

      {/* Zoom level indicator */}
      <div className="flex items-center justify-center gap-1.5 mb-1">
        {zoomLevel === 1 && <span className="text-[10px] opacity-40">L1</span>}
        {zoomLevel === 2 && <span className="text-[10px] opacity-40">L2</span>}
        {zoomLevel === 3 && <span className="text-[10px] opacity-40">L3</span>}
      </div>

      <div className={`${labelSize} text-[var(--color-text)]`}>{label as string}</div>

      {/* Expand/collapse indicator */}
      {hasChildren && (
        <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
          {collapsed ? '+ expand' : '- collapse'}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!bg-[var(--color-border)] !w-2 !h-2" />
    </motion.div>
  );
}

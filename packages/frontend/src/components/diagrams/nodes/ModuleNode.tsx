import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { motion } from 'framer-motion';

type ModuleNodeData = {
  label: string;
  nodeType: 'module' | 'file' | 'area';
  filePath?: string;
  focused: boolean;
  highlighted: boolean;
};

export type ModuleNodeType = Node<ModuleNodeData, 'module'>;

export function ModuleNode({ data }: NodeProps<ModuleNodeType>) {
  const { label, nodeType, focused, highlighted } = data;

  const iconMap: Record<string, string> = { module: '\u{1F4E6}', file: '\u{1F4C4}', area: '\u{1F527}' };
  const icon = iconMap[nodeType] || '\u{1F4E6}';

  return (
    <motion.div
      animate={{
        scale: focused ? 1.15 : 1,
        boxShadow: focused
          ? '0 0 20px rgba(99, 102, 241, 0.5)'
          : highlighted
          ? '0 0 12px rgba(52, 211, 153, 0.3)'
          : '0 0 0px transparent',
      }}
      transition={{ duration: 0.3 }}
      className={`px-4 py-3 rounded-xl border-2 min-w-[140px] text-center transition-colors ${
        focused
          ? 'bg-[#1e1e3a] border-[var(--color-accent)]'
          : highlighted
          ? 'bg-[#1a2a1a] border-[var(--color-green)]'
          : 'bg-[var(--color-surface)] border-[var(--color-border)]'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-[var(--color-border)]" />
      <div className="text-xs mb-1 opacity-60">{icon}</div>
      <div className="text-sm font-medium text-[var(--color-text)]">{label}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-[var(--color-border)]" />
    </motion.div>
  );
}

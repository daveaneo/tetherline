import { useMemo } from 'react';
import { motion } from 'framer-motion';
import type { HeatmapData, HeatmapEntry } from '@interactive-reviewer/shared';

interface Props {
  data: HeatmapData | null;
}

interface TreeNode {
  name: string;
  path: string;
  entries: HeatmapEntry[];
  size: number;
}

function buildTree(entries: HeatmapEntry[]): TreeNode[] {
  const root = new Map<string, HeatmapEntry[]>();

  for (const entry of entries) {
    const parts = entry.filePath.split('/');
    const dir = parts.length > 1 ? parts[0] : '.';
    if (!root.has(dir)) root.set(dir, []);
    root.get(dir)!.push(entry);
  }

  return Array.from(root.entries())
    .map(([name, dirEntries]) => ({
      name,
      path: name,
      entries: dirEntries,
      size: dirEntries.length,
    }))
    .sort((a, b) => b.size - a.size);
}

function getStatusColor(status: 'green' | 'yellow' | 'red'): string {
  switch (status) {
    case 'green': return 'bg-emerald-500/30 border-emerald-500/50';
    case 'yellow': return 'bg-amber-500/30 border-amber-500/50';
    case 'red': return 'bg-red-500/30 border-red-500/50';
  }
}

function getDominantStatus(entries: HeatmapEntry[]): 'green' | 'yellow' | 'red' {
  const counts = { green: 0, yellow: 0, red: 0 };
  for (const e of entries) counts[e.status]++;
  if (counts.red > counts.green && counts.red > counts.yellow) return 'red';
  if (counts.yellow > counts.green) return 'yellow';
  return 'green';
}

export function UnderstandingMap({ data }: Props) {
  const tree = useMemo(() => data ? buildTree(data.entries) : [], [data]);

  if (!data || data.entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-96 text-[var(--color-text-muted)]">
        No file data available
      </div>
    );
  }

  const totalFiles = data.entries.length;
  const greenCount = data.entries.filter(e => e.status === 'green').length;
  const yellowCount = data.entries.filter(e => e.status === 'yellow').length;
  const redCount = data.entries.filter(e => e.status === 'red').length;

  return (
    <div className="w-full">
      {/* Summary stats */}
      <div className="flex gap-6 mb-6 justify-center">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-emerald-500" />
          <span className="text-sm text-[var(--color-text-muted)]">Reviewed ({greenCount})</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-amber-500" />
          <span className="text-sm text-[var(--color-text-muted)]">Changed since review ({yellowCount})</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <span className="text-sm text-[var(--color-text-muted)]">Not reviewed ({redCount})</span>
        </div>
      </div>

      {/* Treemap grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {tree.map((dir, i) => {
          const status = getDominantStatus(dir.entries);
          return (
            <motion.div
              key={dir.name}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.05 }}
              className={`p-4 rounded-xl border ${getStatusColor(status)} cursor-default`}
              style={{
                gridColumn: dir.size > totalFiles * 0.15 ? 'span 2' : 'span 1',
              }}
            >
              <div className="font-medium text-sm mb-2">{dir.name}/</div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {dir.entries.length} files
              </div>
              <div className="flex gap-1 mt-2 flex-wrap">
                {dir.entries.slice(0, 20).map(entry => (
                  <div
                    key={entry.filePath}
                    className={`w-2 h-2 rounded-sm ${
                      entry.status === 'green' ? 'bg-emerald-500'
                      : entry.status === 'yellow' ? 'bg-amber-500'
                      : 'bg-red-500'
                    }`}
                    title={entry.filePath}
                  />
                ))}
                {dir.entries.length > 20 && (
                  <span className="text-xs text-[var(--color-text-muted)]">+{dir.entries.length - 20}</span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

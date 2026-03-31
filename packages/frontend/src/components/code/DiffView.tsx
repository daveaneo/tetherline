import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { motion } from 'framer-motion';

interface Props {
  filePath: string;
  oldCode?: string;
  newCode?: string;
  hunks?: Array<{ content: string }>;
}

// Custom dark theme matching our design system
const customStyles = {
  variables: {
    dark: {
      diffViewerBackground: '#0d0d14',
      diffViewerTitleBackground: '#12121a',
      addedBackground: 'rgba(52, 211, 153, 0.08)',
      addedColor: '#34d399',
      removedBackground: 'rgba(248, 113, 113, 0.08)',
      removedColor: '#f87171',
      wordAddedBackground: 'rgba(52, 211, 153, 0.2)',
      wordRemovedBackground: 'rgba(248, 113, 113, 0.2)',
      addedGutterBackground: 'rgba(52, 211, 153, 0.05)',
      removedGutterBackground: 'rgba(248, 113, 113, 0.05)',
      gutterBackground: '#0a0a0f',
      gutterBackgroundDark: '#0a0a0f',
      highlightBackground: 'rgba(99, 102, 241, 0.1)',
      highlightGutterBackground: 'rgba(99, 102, 241, 0.05)',
      codeFoldGutterBackground: '#12121a',
      codeFoldBackground: '#12121a',
      emptyLineBackground: '#0d0d14',
      gutterColor: '#4a4a6a',
      addedGutterColor: '#34d399',
      removedGutterColor: '#f87171',
      codeFoldContentColor: '#8888a0',
      diffViewerTitleColor: '#e4e4ef',
      diffViewerTitleBorderColor: '#2a2a3a',
    },
  },
  line: {
    padding: '4px 10px',
    fontSize: '13px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  },
};

export function DiffView({ filePath, oldCode, newCode, hunks }: Props) {
  // If we have hunks but not separate old/new code, parse from hunk content
  let left = oldCode ?? '';
  let right = newCode ?? '';

  if ((!oldCode || !newCode) && hunks && hunks.length > 0) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const hunk of hunks) {
      for (const line of hunk.content.split('\n')) {
        if (line.startsWith('-') && !line.startsWith('---')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          newLines.push(line.slice(1));
        } else if (!line.startsWith('@@') && !line.startsWith('diff ') && !line.startsWith('index ')) {
          const content = line.startsWith(' ') ? line.slice(1) : line;
          oldLines.push(content);
          newLines.push(content);
        }
      }
    }
    left = oldLines.join('\n');
    right = newLines.join('\n');
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-[var(--color-border)] overflow-hidden"
    >
      <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <span className="text-xs text-[var(--color-text-muted)] font-mono">{filePath}</span>
      </div>
      <ReactDiffViewer
        oldValue={left}
        newValue={right}
        splitView={false}
        useDarkTheme={true}
        compareMethod={DiffMethod.WORDS}
        styles={customStyles}
        hideLineNumbers={false}
      />
    </motion.div>
  );
}

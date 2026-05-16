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
      diffViewerBackground: 'var(--ink-050)',
      diffViewerTitleBackground: 'var(--ink-100)',
      addedBackground: 'color-mix(in oklch, var(--sig-okay) 10%, transparent)',
      addedColor: 'var(--sig-okay)',
      removedBackground: 'color-mix(in oklch, var(--sig-break) 10%, transparent)',
      removedColor: 'var(--sig-break)',
      wordAddedBackground: 'color-mix(in oklch, var(--sig-okay) 22%, transparent)',
      wordRemovedBackground: 'color-mix(in oklch, var(--sig-break) 22%, transparent)',
      addedGutterBackground: 'color-mix(in oklch, var(--sig-okay) 6%, transparent)',
      removedGutterBackground: 'color-mix(in oklch, var(--sig-break) 6%, transparent)',
      gutterBackground: 'var(--ink-000)',
      gutterBackgroundDark: 'var(--ink-000)',
      highlightBackground: 'color-mix(in oklch, var(--amber-400) 12%, transparent)',
      highlightGutterBackground: 'color-mix(in oklch, var(--amber-400) 7%, transparent)',
      codeFoldGutterBackground: 'var(--ink-100)',
      codeFoldBackground: 'var(--ink-100)',
      emptyLineBackground: 'var(--ink-050)',
      gutterColor: 'var(--color-text-muted)',
      addedGutterColor: 'var(--sig-okay)',
      removedGutterColor: 'var(--sig-break)',
      codeFoldContentColor: 'var(--color-text-muted)',
      diffViewerTitleColor: 'var(--color-text)',
      diffViewerTitleBorderColor: 'var(--color-border)',
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

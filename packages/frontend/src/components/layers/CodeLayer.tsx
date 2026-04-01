import { motion } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';
import { CodeSnippet } from '../code/CodeSnippet.js';

/**
 * Layer 5 — Code view.
 * A full-panel code viewer that shows the current file being discussed.
 * Uses the existing CodeSnippet component expanded to fill the panel.
 */
export function CodeLayer() {
  const state = useSessionStore(s => s.state);
  const areas = useSessionStore(s => s.areas);

  // Get current area and segment
  const area = state.areaIndex !== undefined ? areas[state.areaIndex] : undefined;
  const segment = area?.narrationSegments?.[state.segmentIndex ?? 0];
  const visualCue = segment?.visualCue;

  const code = visualCue?.code ?? '';
  const language = visualCue?.language ?? 'text';
  const filePath = visualCue?.filePath;
  const highlightLines = visualCue?.lines
    ? rangeToArray(visualCue.lines[0], visualCue.lines[1])
    : undefined;

  if (!code && !filePath) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center">
          <div className="text-4xl mb-4 opacity-30">📄</div>
          <p className="text-[var(--color-text-muted)]">
            {area ? `Exploring ${area.name}` : 'Select a file to view code'}
          </p>
          {area && area.affectedFiles.length > 0 && (
            <div className="mt-4 space-y-1">
              {area.affectedFiles.slice(0, 10).map(f => (
                <div key={f} className="text-xs font-mono text-[var(--color-text-muted)] opacity-60">
                  {f}
                </div>
              ))}
              {area.affectedFiles.length > 10 && (
                <div className="text-xs text-[var(--color-text-muted)] opacity-40 mt-2">
                  +{area.affectedFiles.length - 10} more files
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-full overflow-auto p-4"
    >
      <CodeSnippet
        code={code}
        language={language}
        filePath={filePath}
        highlightLines={highlightLines}
      />
    </motion.div>
  );
}

/** Expand a line range [start, end] into an array of line numbers. */
function rangeToArray(start: number, end: number): number[] {
  const lines: number[] = [];
  for (let i = start; i <= end; i++) lines.push(i);
  return lines;
}

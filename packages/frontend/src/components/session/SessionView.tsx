import { useEffect } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { sendEvent } from '../../lib/ws-client.js';
import { api } from '../../lib/api-client.js';
import { AnimatePresence, motion } from 'framer-motion';
import { ArchitectureDiagram } from '../diagrams/ArchitectureDiagram.js';
import { CodeSnippet } from '../code/CodeSnippet.js';
import { DiffView } from '../code/DiffView.js';
import { UnderstandingMap } from '../heatmap/UnderstandingMap.js';
import type { AreaWithContent, NarrationSegment, Concern, ConcernSeverity } from '@interactive-reviewer/shared';

export function SessionView() {
  const { state, context, areas, analysisProgress } = useSession();

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={state.phase}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        transition={{ duration: 0.3 }}
        className="h-full flex flex-col items-center justify-center p-8"
      >
        {state.phase === 'IDLE' && <IdleView />}
        {state.phase === 'ANALYZING' && <AnalyzingView progress={analysisProgress} />}
        {state.phase === 'PREVIOUSLY_ON' && <PreviouslyOnView />}
        {state.phase === 'HEATMAP' && <HeatmapView />}
        {state.phase === 'OVERVIEW' && <OverviewView areas={areas} />}
        {state.phase === 'AREA_WALKTHROUGH' && <AreaWalkthroughView />}
        {state.phase === 'AREA_TRANSITION' && <AreaTransitionView />}
        {state.phase === 'QA' && <AreaWalkthroughView />}
        {state.phase === 'ADVISORY' && <AdvisoryView />}
        {state.phase === 'WRAP_UP' && <WrapUpView />}
        {state.phase === 'EXPORTING' && <ExportingView />}
        {state.phase === 'COMPLETED' && <CompletedView />}
        {state.phase === 'ERROR' && <ErrorView />}
      </motion.div>
    </AnimatePresence>
  );
}

function IdleView() {
  return (
    <div className="text-center max-w-lg">
      <h2 className="text-3xl font-bold mb-4">Interactive Reviewer</h2>
      <p className="text-[var(--color-text-muted)] mb-8">
        Ready to review your codebase. Click start to begin analyzing recent changes.
      </p>
      <button
        onClick={() => sendEvent({ type: 'session:start', payload: { repoPath: '', sinceDays: 7 } })}
        className="px-8 py-3 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg text-lg font-medium transition-colors"
      >
        Start Review Session
      </button>
    </div>
  );
}

function AnalyzingView({ progress }: { progress: { phase: string; progress: number; message: string } | null }) {
  const pct = progress ? Math.round(progress.progress * 100) : 0;
  return (
    <div className="text-center max-w-md">
      <div className="text-2xl font-semibold mb-4">Analyzing Repository</div>
      <div className="text-[var(--color-text-muted)] mb-6">
        {progress?.message ?? 'Starting analysis...'}
      </div>
      <div className="w-full h-2 bg-[var(--color-surface)] rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-[var(--color-accent)] rounded-full"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.3 }}
        />
      </div>
      <div className="text-xs text-[var(--color-text-muted)] mt-2">{pct}%</div>
    </div>
  );
}

function PreviouslyOnView() {
  const recap = useSessionStore(s => s.recap);
  const previousSession = useSessionStore(s => s.previousSession);

  return (
    <div className="text-center max-w-2xl">
      <h2 className="text-2xl font-bold mb-4">Previously on...</h2>
      {previousSession && (
        <p className="text-sm text-[var(--color-text-muted)] mb-4">
          Last session: {previousSession.repoName} - {previousSession.totalCommits} commits, {previousSession.totalAreas} areas
        </p>
      )}
      {recap ? (
        <p className="text-[var(--color-text-muted)] leading-relaxed">{recap}</p>
      ) : (
        <p className="text-[var(--color-text-muted)]">Recap of your last review session</p>
      )}
    </div>
  );
}

function HeatmapView() {
  const heatmap = useSessionStore(s => s.heatmap);

  return (
    <div className="text-center max-w-4xl w-full">
      <h2 className="text-2xl font-bold mb-4">Understanding Map</h2>
      <p className="text-[var(--color-text-muted)] mb-8">Your familiarity with the codebase</p>
      <UnderstandingMap data={heatmap} />
    </div>
  );
}

function OverviewView({ areas }: { areas: AreaWithContent[] }) {
  return (
    <div className="text-center max-w-4xl w-full">
      <h2 className="text-2xl font-bold mb-4">This Week at a Glance</h2>
      <p className="text-[var(--color-text-muted)] mb-8">{areas.length} areas of change</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {areas.map((area) => (
          <div
            key={area.id}
            className="p-4 border border-[var(--color-border)] rounded-xl bg-[var(--color-surface)] text-left hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full ${
                area.significance === 'major' ? 'bg-[var(--color-red)]' :
                area.significance === 'minor' ? 'bg-[var(--color-yellow)]' :
                'bg-[var(--color-green)]'
              }`} />
              <h3 className="font-semibold">{area.name}</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">{area.description}</p>
            <div className="flex gap-2 mt-3">
              <span className="text-xs text-[var(--color-text-muted)] bg-[var(--color-border)]/30 px-2 py-0.5 rounded">
                {area.affectedFiles.length} files
              </span>
              <span className="text-xs text-[var(--color-text-muted)] bg-[var(--color-border)]/30 px-2 py-0.5 rounded">
                {area.commitHashes.length} commits
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AreaWalkthroughView() {
  const state = useSessionStore(s => s.state);
  const areas = useSessionStore(s => s.areas);

  const currentArea: AreaWithContent | undefined = state.areaIndex !== undefined ? areas[state.areaIndex] : undefined;
  const segmentIndex = state.segmentIndex ?? 0;

  if (!currentArea) {
    return (
      <div className="w-full h-full flex items-center justify-center text-[var(--color-text-muted)]">
        Loading area...
      </div>
    );
  }

  const segments = currentArea.narrationSegments;
  const currentSegment: NarrationSegment | undefined = segments[segmentIndex];
  const visualCue = currentSegment?.visualCue;

  // Determine which visual to show on the right panel
  const showCode = visualCue?.type === 'show_code' && visualCue.code != null;
  const showDiff = visualCue?.type === 'show_diff';
  const focusedNodeId = visualCue?.type === 'diagram_focus' ? visualCue.diagramNodeId : undefined;
  const highlightedFiles = visualCue?.type === 'highlight_file' && visualCue.filePath
    ? [visualCue.filePath]
    : currentArea.affectedFiles;

  // Compute highlight lines from visual cue range
  const highlightLines: number[] = [];
  if (visualCue?.lines) {
    const [start, end] = visualCue.lines;
    for (let l = start; l <= end; l++) highlightLines.push(l);
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${
            currentArea.significance === 'major' ? 'bg-[var(--color-red)]' :
            currentArea.significance === 'minor' ? 'bg-[var(--color-yellow)]' :
            'bg-[var(--color-green)]'
          }`} />
          <h3 className="font-semibold text-lg">{currentArea.name}</h3>
        </div>
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <span>Segment {segmentIndex + 1} / {segments.length}</span>
        </div>
      </div>

      {/* Split panel */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Architecture Diagram */}
        <div className="w-1/2 border-r border-[var(--color-border)]">
          {currentArea.architectureNodes.length > 0 ? (
            <ArchitectureDiagram
              nodes={currentArea.architectureNodes}
              edges={currentArea.architectureEdges}
              focusedNodeId={focusedNodeId}
              highlightedFiles={highlightedFiles}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">
              No architecture diagram for this area
            </div>
          )}
        </div>

        {/* Right: Code/Diff view */}
        <div className="w-1/2 overflow-y-auto p-4">
          {showCode && visualCue.code != null && (
            <CodeSnippet
              code={visualCue.code}
              language={visualCue.language ?? 'text'}
              filePath={visualCue.filePath}
              highlightLines={highlightLines}
            />
          )}
          {showDiff && visualCue.filePath && (
            <DiffView
              filePath={visualCue.filePath}
              hunks={[{ content: visualCue.code ?? '' }]}
            />
          )}
          {!showCode && !showDiff && (
            <div className="flex items-center justify-center h-full text-[var(--color-text-muted)]">
              <div className="text-center">
                <div className="text-lg mb-2">{currentArea.name}</div>
                <div className="text-sm">{currentArea.description}</div>
                <div className="text-xs mt-4">{currentArea.affectedFiles.length} affected files</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom: Narration subtitle */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <AnimatePresence mode="wait">
          {currentSegment && (
            <motion.div
              key={currentSegment.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.25 }}
              className="px-8 py-4 text-center"
            >
              <p className="text-[var(--color-text)] leading-relaxed max-w-3xl mx-auto">
                {currentSegment.text}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function severityColor(severity: ConcernSeverity): string {
  switch (severity) {
    case 'critical': return 'border-red-500/60 bg-red-500/10';
    case 'warning': return 'border-amber-500/60 bg-amber-500/10';
    case 'info': return 'border-blue-500/60 bg-blue-500/10';
  }
}

function severityBadge(severity: ConcernSeverity): string {
  switch (severity) {
    case 'critical': return 'bg-red-500/20 text-red-400';
    case 'warning': return 'bg-amber-500/20 text-amber-400';
    case 'info': return 'bg-blue-500/20 text-blue-400';
  }
}

function ConcernCard({ concern }: { concern: Concern }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      className={`p-5 rounded-xl border-l-4 border ${severityColor(concern.severity)}`}
    >
      <div className="flex items-center gap-3 mb-2">
        <span className={`text-xs font-semibold uppercase px-2 py-0.5 rounded ${severityBadge(concern.severity)}`}>
          {concern.severity}
        </span>
        <span className="text-xs text-[var(--color-text-muted)] bg-[var(--color-surface)] px-2 py-0.5 rounded">
          {concern.category}
        </span>
      </div>
      <h4 className="font-semibold mb-1">{concern.title}</h4>
      <p className="text-sm text-[var(--color-text-muted)] mb-3">{concern.description}</p>
      {concern.affectedFiles.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {concern.affectedFiles.map(f => (
            <span key={f} className="text-xs font-mono text-[var(--color-text-muted)] bg-[var(--color-surface)] px-2 py-0.5 rounded">
              {f}
            </span>
          ))}
        </div>
      )}
      {concern.codeReferences.length > 0 && (
        <div className="mt-3">
          {concern.codeReferences.map((ref, i) => (
            <pre key={i} className="text-xs font-mono bg-[#0d0d14] p-2 rounded mt-1 overflow-x-auto">
              <span className="text-[var(--color-text-muted)]">{ref.filePath}:{ref.startLine}-{ref.endLine}</span>
              {'\n'}
              <code className="text-[var(--color-text)]">{ref.snippet}</code>
            </pre>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function AdvisoryView() {
  const concerns = useSessionStore(s => s.concerns);

  const criticals = concerns.filter(c => c.severity === 'critical');
  const warnings = concerns.filter(c => c.severity === 'warning');
  const infos = concerns.filter(c => c.severity === 'info');

  return (
    <div className="max-w-3xl w-full">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold mb-2">AI Observations</h2>
        <p className="text-[var(--color-text-muted)]">
          {concerns.length} concerns flagged during review
        </p>
      </div>

      {concerns.length === 0 ? (
        <div className="text-center text-[var(--color-text-muted)] py-12">
          No concerns detected. Looking good!
        </div>
      ) : (
        <div className="space-y-4">
          {criticals.map(c => <ConcernCard key={c.id} concern={c} />)}
          {warnings.map(c => <ConcernCard key={c.id} concern={c} />)}
          {infos.map(c => <ConcernCard key={c.id} concern={c} />)}
        </div>
      )}
    </div>
  );
}

function WrapUpView() {
  const heatmap = useSessionStore(s => s.heatmap);
  const sessionId = useSessionStore(s => s.context.sessionId);

  const handleExport = async (format: 'slides' | 'markdown') => {
    try {
      const result = format === 'slides'
        ? await api.exportSlides(sessionId)
        : await api.exportMarkdown(sessionId);
      window.open(result.downloadUrl, '_blank');
    } catch (err: any) {
      console.error(`Export failed:`, err);
    }
  };

  return (
    <div className="max-w-4xl w-full">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold mb-2">Session Complete</h2>
        <p className="text-[var(--color-text-muted)] mb-8">Review your understanding and export</p>
      </div>

      {/* Updated heatmap */}
      <div className="mb-8">
        <UnderstandingMap data={heatmap} />
      </div>

      {/* Export buttons */}
      <div className="flex gap-4 justify-center">
        <button
          onClick={() => handleExport('slides')}
          className="px-6 py-3 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg transition-colors"
        >
          Export Slides
        </button>
        <button
          onClick={() => handleExport('markdown')}
          className="px-6 py-3 border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] rounded-lg transition-colors"
        >
          Export Markdown
        </button>
      </div>
    </div>
  );
}

function AreaTransitionView() {
  useEffect(() => {
    const timer = setTimeout(() => {
      sendEvent({ type: 'command:next' });
    }, 1000);
    return () => clearTimeout(timer);
  }, []);

  const areas = useSessionStore(s => s.areas);
  const state = useSessionStore(s => s.state);
  const nextArea = state.areaIndex !== undefined ? areas[state.areaIndex] : undefined;

  return (
    <div className="text-center max-w-lg">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
      >
        <h2 className="text-2xl font-bold mb-4">Moving to next area...</h2>
        {nextArea && (
          <p className="text-[var(--color-text-muted)]">{nextArea.name}</p>
        )}
      </motion.div>
    </div>
  );
}

function ExportingView() {
  return (
    <div className="text-center max-w-md">
      <div className="animate-spin w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full mx-auto mb-4" />
      <h2 className="text-2xl font-semibold mb-2">Generating export...</h2>
      <p className="text-[var(--color-text-muted)]">This may take a moment.</p>
    </div>
  );
}

function ErrorView() {
  const state = useSessionStore(s => s.state);
  const errorMsg = state.error ?? 'An unknown error occurred';

  return (
    <div className="text-center max-w-lg">
      <h2 className="text-2xl font-bold mb-4 text-red-400">Error</h2>
      <p className="text-[var(--color-text-muted)] mb-8">{errorMsg}</p>
      <button
        onClick={() => sendEvent({ type: 'session:start', payload: { repoPath: '', sinceDays: 7 } })}
        className="px-8 py-3 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg text-lg font-medium transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

function CompletedView() {
  return (
    <div className="text-center max-w-lg">
      <h2 className="text-2xl font-bold mb-4">See You Next Week</h2>
      <p className="text-[var(--color-text-muted)]">Your understanding map has been updated.</p>
    </div>
  );
}

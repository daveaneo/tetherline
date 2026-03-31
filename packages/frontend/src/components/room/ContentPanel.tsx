import { useEffect } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { CodeSnippet } from '../code/CodeSnippet.js';
import { DiffView } from '../code/DiffView.js';
import { UnderstandingMap } from '../heatmap/UnderstandingMap.js';
import { AnimatePresence, motion } from 'framer-motion';
import type { AreaWithContent, Concern, UnderstandingState, SkillResult } from '@interactive-reviewer/shared';
import { sendEvent } from '../../lib/ws-client.js';

export function ContentPanel() {
  const { state, areas, analysisProgress, context } = useSession();
  const heatmap = useSessionStore(s => s.heatmap);
  const concerns = useSessionStore(s => s.concerns);
  const recap = useSessionStore(s => s.recap);
  const previousSession = useSessionStore(s => s.previousSession);
  const understanding = useSessionStore(s => s.understanding);
  const skillResult = useSessionStore(s => s.skillResult);
  const skillClarification = useSessionStore(s => s.skillClarification);

  const currentArea = state.areaIndex !== undefined ? areas[state.areaIndex] : undefined;
  const currentSegment = currentArea?.narrationSegments?.[state.segmentIndex ?? 0];

  // Auto-dismiss skill result after 15 seconds or on phase change
  useEffect(() => {
    if (!skillResult) return;
    const timer = setTimeout(() => {
      useSessionStore.setState({ skillResult: null });
    }, 15000);
    return () => clearTimeout(timer);
  }, [skillResult]);

  useEffect(() => {
    useSessionStore.setState({ skillResult: null, skillClarification: null });
  }, [state.phase, state.areaIndex, state.segmentIndex]);

  return (
    <div className="h-full p-6 overflow-y-auto">
      {/* Skill result overlay -- takes priority when present */}
      <AnimatePresence>
        {skillResult && (
          <motion.div
            key="skill-result"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="mb-6"
          >
            <SkillResultPanel result={skillResult} onDismiss={() => useSessionStore.setState({ skillResult: null })} />
          </motion.div>
        )}
        {skillClarification && !skillResult && (
          <motion.div
            key="skill-clarify"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="mb-6"
          >
            <SkillClarifyPanel
              message={skillClarification.message}
              options={skillClarification.options}
              onSelect={(option) => {
                sendEvent({ type: 'user:utterance', payload: { text: option, timestamp: Date.now() } });
                useSessionStore.setState({ skillClarification: null });
              }}
              onDismiss={() => useSessionStore.setState({ skillClarification: null })}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        <motion.div
          key={`${state.phase}-${state.areaIndex}-${state.segmentIndex}`}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.25 }}
        >
          {state.phase === 'ANALYZING' && (
            <AnalyzingContent progress={analysisProgress} />
          )}

          {state.phase === 'PREVIOUSLY_ON' && (
            <RecapContent recap={recap} previousSession={previousSession} />
          )}

          {state.phase === 'HEATMAP' && (
            <div>
              <h2 className="text-xl font-semibold mb-4">Understanding Map</h2>
              <UnderstandingMap data={heatmap} />
            </div>
          )}

          {state.phase === 'PROJECT_OVERVIEW' && (
            <ProjectOverviewContent areas={areas} understanding={understanding} />
          )}

          {state.phase === 'ARCHITECTURE_OVERVIEW' && (
            <ArchitectureOverviewContent areas={areas} understanding={understanding} />
          )}

          {state.phase === 'COMPONENT_TOUR' && currentArea && (
            <AreaContent area={currentArea} segment={currentSegment} />
          )}

          {state.phase === 'OVERVIEW' && (
            <OverviewContent areas={areas} />
          )}

          {(state.phase === 'AREA_WALKTHROUGH' || state.phase === 'QA') && currentArea && (
            <AreaContent area={currentArea} segment={currentSegment} />
          )}

          {state.phase === 'ADVISORY' && (
            <ConcernsContent concerns={concerns} />
          )}

          {state.phase === 'WRAP_UP' && (
            <WrapUpContent heatmap={heatmap} sessionId={context.sessionId} />
          )}

          {state.phase === 'COMPLETED' && (
            <div className="text-center py-12">
              <h2 className="text-2xl font-bold mb-3">Session Complete</h2>
              <p className="text-[var(--color-text-muted)]">Your understanding map has been updated.</p>
            </div>
          )}

          {state.phase === 'ERROR' && (
            <div className="text-center py-12">
              <h2 className="text-xl font-bold text-red-400 mb-3">Something went wrong</h2>
              <p className="text-[var(--color-text-muted)]">{state.error ?? 'An unexpected error occurred'}</p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function AnalyzingContent({ progress }: { progress: { phase: string; progress: number; message: string } | null }) {
  return (
    <div className="space-y-6 py-8">
      <h2 className="text-xl font-semibold">Analyzing Repository</h2>
      <div className="space-y-3">
        <div className="h-2 bg-[var(--color-border)] rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-[var(--color-accent)] rounded-full"
            animate={{ width: `${(progress?.progress ?? 0) * 100}%` }}
            transition={{ duration: 0.5 }}
          />
        </div>
        <p className="text-sm text-[var(--color-text-muted)]">{progress?.message ?? 'Starting...'}</p>
      </div>
    </div>
  );
}

function RecapContent({ recap, previousSession }: { recap: string | null; previousSession: any }) {
  return (
    <div className="space-y-4 py-8">
      <h2 className="text-xl font-semibold">Previously...</h2>
      {previousSession && (
        <div className="p-4 bg-[var(--color-bg)] rounded-xl border border-[var(--color-border)]">
          <p className="text-sm text-[var(--color-text-muted)] mb-1">
            Last session: {previousSession.totalCommits} commits, {previousSession.totalAreas} areas
          </p>
        </div>
      )}
      {recap && <p className="text-[var(--color-text)] leading-relaxed">{recap}</p>}
    </div>
  );
}

function OverviewContent({ areas }: { areas: AreaWithContent[] }) {
  return (
    <div className="space-y-4 py-4">
      <h2 className="text-xl font-semibold">This Week's Changes</h2>
      <div className="space-y-3">
        {areas.map((area) => (
          <div
            key={area.id}
            className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${
                area.significance === 'major' ? 'bg-[var(--color-red)]' :
                area.significance === 'minor' ? 'bg-[var(--color-yellow)]' :
                'bg-[var(--color-green)]'
              }`} />
              <h3 className="font-medium">{area.name}</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">{area.description}</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-2">
              {area.commitHashes.length} commits &middot; {area.affectedFiles.length} files
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AreaContent({ area, segment }: { area: AreaWithContent; segment?: AreaWithContent['narrationSegments'][number] }) {
  const visualCue = segment?.visualCue;

  return (
    <div className="space-y-4">
      {/* Area header */}
      <div>
        <h2 className="text-xl font-semibold">{area.name}</h2>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">{area.description}</p>
      </div>

      {/* Visual cue content */}
      {visualCue?.type === 'show_code' && visualCue.code && (
        <CodeSnippet
          code={visualCue.code}
          language={visualCue.language ?? 'text'}
          filePath={visualCue.filePath}
          highlightLines={visualCue.lines ? [visualCue.lines[0], visualCue.lines[1]] : undefined}
        />
      )}

      {visualCue?.type === 'show_diff' && visualCue.filePath && (
        <DiffView
          filePath={visualCue.filePath}
          hunks={[{ content: visualCue.code ?? '' }]}
        />
      )}

      {visualCue?.type === 'highlight_file' && visualCue.filePath && (
        <div className="p-4 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5">
          <p className="text-sm font-mono text-[var(--color-accent)]">{visualCue.filePath}</p>
        </div>
      )}

      {(!visualCue || visualCue.type === 'none' || visualCue.type === 'diagram_focus') && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Files in this area</h3>
          <div className="space-y-1">
            {area.affectedFiles.slice(0, 15).map(f => (
              <div key={f} className="text-xs font-mono text-[var(--color-text-muted)] py-0.5">{f}</div>
            ))}
            {area.affectedFiles.length > 15 && (
              <div className="text-xs text-[var(--color-text-muted)]">...and {area.affectedFiles.length - 15} more</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConcernsContent({ concerns }: { concerns: Concern[] }) {
  const sorted = [...concerns].sort((a, b) => {
    const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    return (order[a.severity] ?? 2) - (order[b.severity] ?? 2);
  });

  return (
    <div className="space-y-4 py-4">
      <h2 className="text-xl font-semibold">AI Observations</h2>
      {sorted.length === 0 ? (
        <p className="text-[var(--color-text-muted)]">No concerns flagged.</p>
      ) : (
        <div className="space-y-3">
          {sorted.map(c => (
            <div
              key={c.id}
              className={`p-4 rounded-xl border ${
                c.severity === 'critical' ? 'border-red-500/40 bg-red-500/5' :
                c.severity === 'warning' ? 'border-amber-500/40 bg-amber-500/5' :
                'border-[var(--color-border)] bg-[var(--color-bg)]'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  c.severity === 'critical' ? 'bg-red-500/20 text-red-400' :
                  c.severity === 'warning' ? 'bg-amber-500/20 text-amber-400' :
                  'bg-[var(--color-surface)] text-[var(--color-text-muted)]'
                }`}>{c.severity}</span>
                <span className="text-xs text-[var(--color-text-muted)]">{c.category}</span>
              </div>
              <h3 className="font-medium mb-1">{c.title}</h3>
              <p className="text-sm text-[var(--color-text-muted)]">{c.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectOverviewContent({ areas, understanding }: { areas: AreaWithContent[]; understanding: UnderstandingState | null }) {
  const totalFiles = areas.reduce((sum, a) => sum + a.affectedFiles.length, 0);

  return (
    <div className="space-y-6 py-4">
      <h2 className="text-xl font-semibold">Project Overview</h2>
      <p className="text-[var(--color-text-muted)]">Getting to know this codebase for the first time.</p>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)]">
          <div className="text-2xl font-bold">{areas.length}</div>
          <div className="text-xs text-[var(--color-text-muted)]">Key Areas</div>
        </div>
        <div className="p-4 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)]">
          <div className="text-2xl font-bold">{totalFiles}</div>
          <div className="text-xs text-[var(--color-text-muted)]">Files Tracked</div>
        </div>
      </div>

      {/* Understanding layers */}
      {understanding && understanding.layers.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Understanding Progress</h3>
          {understanding.layers.map(layer => (
            <div key={layer.level} className="flex items-center gap-3">
              <span className="text-xs w-24 text-[var(--color-text-muted)] capitalize">{layer.level}</span>
              <div className="flex-1 h-1.5 bg-[var(--color-bg)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--color-accent)] rounded-full transition-all duration-500"
                  style={{ width: `${layer.percentage}%` }}
                />
              </div>
              <span className="text-xs text-[var(--color-text-muted)] w-10 text-right">{layer.percentage}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Area list preview */}
      {areas.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Areas to Explore</h3>
          {areas.slice(0, 6).map(area => (
            <div key={area.id} className="flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${
                area.significance === 'major' ? 'bg-[var(--color-red)]' :
                area.significance === 'minor' ? 'bg-[var(--color-yellow)]' :
                'bg-[var(--color-green)]'
              }`} />
              <span>{area.name}</span>
            </div>
          ))}
          {areas.length > 6 && (
            <div className="text-xs text-[var(--color-text-muted)]">...and {areas.length - 6} more</div>
          )}
        </div>
      )}
    </div>
  );
}

function ArchitectureOverviewContent({ areas, understanding }: { areas: AreaWithContent[]; understanding: UnderstandingState | null }) {
  // Use architecture data from the first area (shared across all areas)
  const nodes = areas[0]?.architectureNodes ?? [];

  // Group nodes by type for display
  const modules = nodes.filter(n => n.type === 'module');
  const files = nodes.filter(n => n.type === 'file');

  return (
    <div className="space-y-6 py-4">
      <h2 className="text-xl font-semibold">Architecture Overview</h2>
      <p className="text-[var(--color-text-muted)]">How the codebase is structured and organized.</p>

      {/* Module breakdown */}
      {modules.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Modules</h3>
          <div className="grid grid-cols-2 gap-2">
            {modules.slice(0, 10).map(mod => {
              const children = files.filter(f => f.parentId === mod.id);
              return (
                <div key={mod.id} className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
                  <div className="font-medium text-sm">{mod.label}</div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-1">{children.length} files</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Areas mapped to architecture */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Change Areas</h3>
        {areas.map((area) => (
          <div
            key={area.id}
            className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${
                area.significance === 'major' ? 'bg-[var(--color-red)]' :
                area.significance === 'minor' ? 'bg-[var(--color-yellow)]' :
                'bg-[var(--color-green)]'
              }`} />
              <h3 className="font-medium">{area.name}</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">{area.description}</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-2">
              {area.commitHashes.length} commits &middot; {area.affectedFiles.length} files
            </p>
          </div>
        ))}
      </div>

      {/* Understanding progress */}
      {understanding && (
        <div className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--color-text-muted)]">Overall Understanding</span>
            <span className="text-sm font-medium">{understanding.overallPercentage}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

const SKILL_LABELS: Record<string, string> = {
  explain: 'Explanation',
  visualize: 'Visualization',
  compare: 'Comparison',
  critique: 'Critique',
  summarize: 'Summary',
  navigate: 'Navigation',
  teach: 'Lesson',
  annotate: 'Annotation',
};

const SKILL_TYPE_ICONS: Record<string, string> = {
  diagram: 'diagram',
  code: 'code',
  diff: 'diff',
  comparison: 'comparison',
  explanation: 'explanation',
  annotation: 'note',
};

function SkillResultPanel({ result, onDismiss }: { result: SkillResult; onDismiss: () => void }) {
  return (
    <div className="p-5 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 relative">
      <button
        onClick={onDismiss}
        className="absolute top-3 right-3 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-sm"
        aria-label="Dismiss"
      >
        &times;
      </button>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
          {SKILL_LABELS[result.skillName] ?? result.skillName}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {SKILL_TYPE_ICONS[result.type] ?? result.type}
        </span>
      </div>
      <p className="text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">{result.narration}</p>
      {result.diagramChanges?.focusNodeId && (
        <div className="mt-3 text-xs text-[var(--color-text-muted)]">
          Focused on: {result.diagramChanges.focusNodeId}
        </div>
      )}
      {result.understandingUpdates && result.understandingUpdates.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {result.understandingUpdates.map((u, i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-green)]/20 text-[var(--color-green)]">
              {u.itemId}: {u.status}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillClarifyPanel({
  message, options, onSelect, onDismiss,
}: {
  message: string;
  options: string[];
  onSelect: (option: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div className="p-5 rounded-xl border border-[var(--color-yellow)]/30 bg-[var(--color-yellow)]/5 relative">
      <button
        onClick={onDismiss}
        className="absolute top-3 right-3 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-sm"
        aria-label="Dismiss"
      >
        &times;
      </button>
      <p className="text-[var(--color-text)] mb-3">{message}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option, i) => (
          <button
            key={i}
            onClick={() => onSelect(option)}
            className="px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function WrapUpContent({ heatmap, sessionId }: { heatmap: any; sessionId: string }) {
  const handleExport = async (format: 'slides' | 'markdown') => {
    try {
      const { api } = await import('../../lib/api-client.js');
      const result = format === 'slides'
        ? await api.exportSlides(sessionId)
        : await api.exportMarkdown(sessionId);
      window.open(result.downloadUrl, '_blank');
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  return (
    <div className="space-y-6 py-4">
      <h2 className="text-xl font-semibold">Session Complete</h2>
      <UnderstandingMap data={heatmap} />
      <div className="flex gap-3">
        <button
          onClick={() => handleExport('slides')}
          className="px-5 py-2.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg text-sm transition-colors"
        >
          Export Slides
        </button>
        <button
          onClick={() => handleExport('markdown')}
          className="px-5 py-2.5 border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] rounded-lg text-sm transition-colors"
        >
          Export Markdown
        </button>
      </div>
    </div>
  );
}

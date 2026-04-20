import { useEffect, useRef } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore, type ConversationEntry } from '../../state/session-store.js';
import { useAudioStore } from '../../state/audio-store.js';
import { CodeSnippet } from '../code/CodeSnippet.js';
import { CodeMorphing } from '../code/CodeMorphing.js';
import { DiffView } from '../code/DiffView.js';
import { UnderstandingMap } from '../heatmap/UnderstandingMap.js';
import { AnimatePresence, motion } from 'framer-motion';
import type { AreaWithContent, Concern, UnderstandingState, SkillResult } from '@tetherline/shared';
import { sendEvent } from '../../lib/ws-client.js';
import { IssueDraftPreview } from '../actions/IssueDraftPreview.js';
import { SharePanel } from '../actions/SharePanel.js';
import { AnnotationsList } from '../actions/AnnotationsList.js';

export function ContentPanel() {
  const { state, areas, analysisProgress, context } = useSession();
  const heatmap = useSessionStore(s => s.heatmap);
  const concerns = useSessionStore(s => s.concerns);
  const recap = useSessionStore(s => s.recap);
  const previousSession = useSessionStore(s => s.previousSession);
  const understanding = useSessionStore(s => s.understanding);
  const proposal = useSessionStore(s => s.proposal);
  const skillResult = useSessionStore(s => s.skillResult);
  const skillClarification = useSessionStore(s => s.skillClarification);
  const conversationHistory = useSessionStore(s => s.conversationHistory);
  const activeRepoPath = useSessionStore(s => s.activeRepoPath);
  const voiceState = useAudioStore(s => s.voiceState);
  const speechToasts = useAudioStore(s => s.speechToasts);

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

  const lastSpeechText = speechToasts.length > 0 ? speechToasts[speechToasts.length - 1].text : null;

  return (
    <div className="h-full flex flex-col">
      {/* Phase content area (~70%) */}
      <div className="flex-[7] p-6 overflow-y-auto relative">
        {/* Processing overlay */}
        <AnimatePresence>
          {voiceState === 'processing' && (
            <motion.div
              key="processing-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-surface)]/80 backdrop-blur-sm"
            >
              <div className="text-center space-y-3">
                {lastSpeechText && (
                  <p className="text-sm text-[var(--color-green)] font-medium">
                    &ldquo;{lastSpeechText}&rdquo;
                  </p>
                )}
                <div className="flex items-center justify-center gap-2">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    className="w-5 h-5 border-2 rounded-full border-[var(--color-yellow)] border-t-transparent"
                  />
                  <span className="text-sm text-[var(--color-yellow)] font-medium">Thinking...</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

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

            {state.phase === 'PROPOSAL' && proposal && (
              <ProposalContent proposal={proposal} />
            )}

            {state.phase === 'PREVIOUSLY_ON' && (
              <RecapContent recap={recap} previousSession={previousSession} />
            )}

            {state.phase === 'HEATMAP' && (
              <div>
                <div className="kicker mb-2">Coverage</div>
              <h2 className="font-serif mb-6" style={{ fontSize: 36, fontWeight: 300, letterSpacing: '-0.02em', color: 'var(--cream-900)' }}>Understanding map</h2>
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
              <div className="text-center py-16">
                <div className="kicker mb-3">Fin</div>
                <h2 className="font-serif" style={{ fontSize: 56, fontWeight: 300, letterSpacing: '-0.025em', color: 'var(--cream-900)' }}>
                  Session complete.
                </h2>
                <p className="mt-4" style={{ color: 'var(--cream-500)' }}>
                  Your understanding map has been updated.
                </p>
              </div>
            )}

            {state.phase === 'ERROR' && (
              <div className="text-center py-16">
                <div className="kicker mb-3" style={{ color: 'var(--sig-break)' }}>Error</div>
                <h2 className="font-serif" style={{ fontSize: 40, fontWeight: 300, letterSpacing: '-0.02em', color: 'var(--cream-900)' }}>
                  Something went wrong.
                </h2>
                <p className="mt-4" style={{ color: 'var(--cream-500)' }}>
                  {state.error ?? 'An unexpected error occurred'}
                </p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Annotations list */}
      {activeRepoPath && (
        <div className="px-4 py-2 shrink-0">
          <AnnotationsList repoPath={activeRepoPath} />
        </div>
      )}

      {/* Conversation history (~30%) */}
      {conversationHistory.length > 0 && (
        <div className="flex-[3] border-t border-[var(--color-border)]">
          <ConversationHistory entries={conversationHistory} />
        </div>
      )}
    </div>
  );
}

function ConversationHistory({ entries }: { entries: ConversationEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayEntries = entries.slice(-20);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [displayEntries.length]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 flex items-center gap-2 shrink-0">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">Conversation</span>
        <span className="text-xs text-[var(--color-text-muted)] opacity-50">{entries.length} messages</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-3 space-y-2">
        {displayEntries.map((entry, i) => (
          <div key={`${entry.timestamp}-${i}`} className="flex gap-2 text-sm">
            <span className={`shrink-0 text-xs font-medium w-8 pt-0.5 ${
              entry.speaker === 'you' ? 'text-[var(--color-green)]' : 'text-[var(--color-accent)]'
            }`}>
              {entry.speaker === 'you' ? 'You' : 'AI'}
            </span>
            <p className={`flex-1 leading-relaxed ${
              entry.speaker === 'you' ? 'text-[var(--color-green)]' : 'text-[var(--color-text)]'
            }`}>
              {entry.text.length > 200 ? entry.text.slice(0, 200) + '...' : entry.text}
            </p>
            <span className="shrink-0 text-[10px] text-[var(--color-text-muted)] opacity-40 pt-0.5">
              {formatTime(entry.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function AnalyzingContent({ progress }: { progress: { phase: string; progress: number; message: string } | null }) {
  return (
    <div className="space-y-6 py-8">
      <div className="kicker">Reading</div>
      <h2 className="font-serif" style={{ fontSize: 40, fontWeight: 300, letterSpacing: '-0.02em', color: 'var(--cream-900)' }}>
        Getting to know your repository.
      </h2>
      <div className="space-y-3 max-w-xl">
        <div className="und-bar" style={{ height: 4 }}>
          <motion.div
            className="fill"
            animate={{ width: `${(progress?.progress ?? 0) * 100}%` }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          />
        </div>
        <p className="font-mono" style={{ fontSize: 12, color: 'var(--cream-500)', letterSpacing: '0.02em' }}>
          {progress?.message ?? 'Starting…'}
        </p>
      </div>
    </div>
  );
}

function ProposalContent({ proposal }: { proposal: { message: string; suggestedOrder: string[]; areas: Array<{ id: string; name: string; significance: string }> } }) {
  return (
    <div className="space-y-6 py-4">
      <div className="kicker">Tour plan</div>
      <h2 className="font-serif" style={{ fontSize: 40, fontWeight: 300, letterSpacing: '-0.02em', color: 'var(--cream-900)', maxWidth: '22ch', lineHeight: 1.05 }}>
        Here&apos;s what I&apos;d like to show you.
      </h2>
      <p className="narration" style={{ fontSize: 18 }}>{proposal.message}</p>

      <div className="space-y-2">
        <h3 className="kicker">Suggested order</h3>
        <div className="space-y-2">
          {proposal.areas.map((area, index) => (
            <div
              key={area.id}
              className="panel-muted flex items-center gap-3"
              style={{ padding: '14px 16px' }}
            >
              <span className="font-mono" style={{ width: 24, textAlign: 'right', color: 'var(--cream-400)', fontSize: 12 }}>
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className={`w-2 h-2 rounded-full`} style={{
                background: area.significance === 'major' ? 'var(--sig-break)' :
                            area.significance === 'minor' ? 'var(--sig-concern)' :
                            'var(--sig-okay)',
              }} />
              <span className="font-serif" style={{ fontSize: 17, color: 'var(--cream-900)', letterSpacing: '-0.005em' }}>
                {area.name}
              </span>
              <span className="font-mono ml-auto" style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
                {area.significance}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => sendEvent({ type: 'command:next' })}
          className="btn btn-primary"
        >
          Let&apos;s go
        </button>
        <span className="font-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
          or say &ldquo;let&apos;s go&rdquo;
        </span>
      </div>
    </div>
  );
}

function RecapContent({ recap, previousSession }: { recap: string | null; previousSession: any }) {
  return (
    <div className="space-y-5 py-8">
      <div className="kicker" style={{ color: 'var(--amber-400)' }}>Previously on</div>
      <h2 className="font-serif" style={{ fontSize: 48, fontWeight: 300, letterSpacing: '-0.025em', color: 'var(--cream-900)', maxWidth: '20ch', lineHeight: 1.02 }}>
        {previousSession ? 'Where we left off.' : 'A fresh start.'}
      </h2>
      {previousSession && (
        <div className="prev-meta-row">
          <span><b>{previousSession.totalCommits}</b>commits</span>
          <span><b>{previousSession.totalAreas}</b>areas</span>
        </div>
      )}
      {recap && (
        <p className="narration" style={{ fontSize: 20, maxWidth: '58ch' }}>{recap}</p>
      )}
    </div>
  );
}

function OverviewContent({ areas }: { areas: AreaWithContent[] }) {
  const sortedAreas = [...areas].sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0));
  const themes = new Map<string, AreaWithContent[]>();
  for (const area of sortedAreas) {
    const theme = area.theme ?? 'Other';
    if (!themes.has(theme)) themes.set(theme, []);
    themes.get(theme)!.push(area);
  }
  const hasThemes = sortedAreas.some(a => a.theme);

  return (
    <div className="space-y-6 py-4">
      <div>
        <div className="kicker">This week</div>
        <h2 className="font-serif mt-2" style={{ fontSize: 40, fontWeight: 300, letterSpacing: '-0.02em', color: 'var(--cream-900)' }}>
          What changed.
        </h2>
      </div>
      {hasThemes ? (
        // Grouped by theme
        Array.from(themes.entries()).map(([theme, themeAreas]) => (
          <div key={theme} className="space-y-2">
            <h3 className="text-sm font-medium text-[var(--color-text-muted)] uppercase tracking-wide">{theme}</h3>
            <div className="space-y-3">
              {themeAreas.map((area) => (
                <OverviewAreaCard key={area.id} area={area} />
              ))}
            </div>
          </div>
        ))
      ) : (
        // Flat list (no themes available)
        <div className="space-y-3">
          {sortedAreas.map((area) => (
            <OverviewAreaCard key={area.id} area={area} />
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewAreaCard({ area }: { area: AreaWithContent }) {
  return (
    <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${
          area.significance === 'major' ? 'bg-[var(--color-red)]' :
          area.significance === 'minor' ? 'bg-[var(--color-yellow)]' :
          'bg-[var(--color-green)]'
        }`} />
        <h3 className="font-medium">{area.name}</h3>
        {area.impactScore != null && (
          <div className="ml-auto flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-[var(--color-border)] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${area.impactScore}%`,
                  backgroundColor: area.impactScore >= 70 ? 'var(--color-red)' :
                    area.impactScore >= 40 ? 'var(--color-yellow)' : 'var(--color-green)',
                }}
              />
            </div>
            <span className="text-[10px] font-medium text-[var(--color-text-muted)]">{area.impactScore}</span>
          </div>
        )}
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">{area.description}</p>
      {area.impactSummary && (
        <p className="text-xs text-[var(--color-accent)] mt-1.5 italic">{area.impactSummary}</p>
      )}
      <p className="text-xs text-[var(--color-text-muted)] mt-2">
        {area.commitHashes.length} commits &middot; {area.affectedFiles.length} files
      </p>
      {area.riskFlags && area.riskFlags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {area.riskFlags.map((flag, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20">{flag}</span>
          ))}
        </div>
      )}
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
    <div className="space-y-5 py-4">
      <div>
        <div className="kicker">Advisory</div>
        <h2 className="font-serif mt-2" style={{ fontSize: 40, fontWeight: 300, letterSpacing: '-0.02em', color: 'var(--cream-900)' }}>
          Things worth a look.
        </h2>
      </div>
      {sorted.length === 0 ? (
        <p className="narration" style={{ fontSize: 18, color: 'var(--cream-500)' }}>No concerns flagged. Quiet week.</p>
      ) : (
        <div className="space-y-3">
          {sorted.map(c => {
            const kind = c.severity === 'critical' ? 'break' : c.severity === 'warning' ? 'concern' : 'muted';
            const accent = c.severity === 'critical' ? 'var(--sig-break)' : c.severity === 'warning' ? 'var(--sig-concern)' : 'oklch(1 0 0 / 0.08)';
            return (
              <div
                key={c.id}
                className="panel-muted"
                style={{ padding: 20, borderLeft: `2px solid ${accent}` }}
              >
                <div className="flex items-center gap-3 mb-2">
                  <span className={`badge badge-${kind}`}>
                    <span className="pip" />
                    {c.severity}
                  </span>
                  <span className="font-mono" style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
                    {c.category}
                  </span>
                </div>
                <h3 className="font-serif" style={{ fontSize: 20, letterSpacing: '-0.01em', color: 'var(--cream-900)' }}>{c.title}</h3>
                <p className="mt-1.5" style={{ fontSize: 14, color: 'var(--cream-600)', lineHeight: 1.6 }}>{c.description}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectOverviewContent({ areas, understanding }: { areas: AreaWithContent[]; understanding: UnderstandingState | null }) {
  const totalFiles = areas.reduce((sum, a) => sum + a.affectedFiles.length, 0);

  return (
    <div className="space-y-6 py-4">
      <div>
        <div className="kicker">First look</div>
        <h2 className="font-serif mt-2" style={{ fontSize: 40, fontWeight: 300, letterSpacing: '-0.02em', color: 'var(--cream-900)' }}>
          Project overview.
        </h2>
        <p className="mt-3" style={{ color: 'var(--cream-500)', fontSize: 16 }}>
          Getting to know this codebase for the first time.
        </p>
      </div>

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
  const nodes = areas[0]?.architectureNodes ?? [];
  const modules = nodes.filter(n => n.type === 'module');
  const files = nodes.filter(n => n.type === 'file');

  return (
    <div className="space-y-6 py-4">
      <div>
        <div className="kicker">The map</div>
        <h2 className="font-serif mt-2" style={{ fontSize: 40, fontWeight: 300, letterSpacing: '-0.02em', color: 'var(--cream-900)' }}>
          Architecture overview.
        </h2>
        <p className="mt-3" style={{ color: 'var(--cream-500)', fontSize: 16 }}>
          How the codebase is structured and organized.
        </p>
      </div>

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
  create_issue: 'GitHub Issue',
  share_explanation: 'Share',
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
  // Action-specific renderers
  if (result.visualPayload.action === 'issue_preview') {
    return (
      <IssueDraftPreview
        title={result.visualPayload.issueTitle as string}
        body={result.visualPayload.issueBody as string}
        labels={(result.visualPayload.issueLabels as string[]) ?? []}
        onDismiss={onDismiss}
      />
    );
  }

  if (result.visualPayload.action === 'share_preview') {
    return (
      <SharePanel
        markdown={result.visualPayload.markdown as string}
        onDismiss={onDismiss}
      />
    );
  }

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
      {result.type === 'comparison' && typeof result.visualPayload.oldCode === 'string' && typeof result.visualPayload.newCode === 'string' && (
        <div className="mt-3">
          <CodeMorphing
            oldCode={result.visualPayload.oldCode}
            newCode={result.visualPayload.newCode}
            language={(result.visualPayload.language as string) ?? 'text'}
            filePath={result.visualPayload.filePath as string}
          />
        </div>
      )}
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
      <div>
        <div className="kicker">End credits</div>
        <h2 className="font-serif mt-2" style={{ fontSize: 48, fontWeight: 300, letterSpacing: '-0.025em', color: 'var(--cream-900)' }}>
          Session complete.
        </h2>
      </div>
      <UnderstandingMap data={heatmap} />
      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <button type="button" onClick={() => handleExport('slides')} className="btn btn-primary">
            Export slides
          </button>
          <button type="button" onClick={() => handleExport('markdown')} className="btn btn-ghost">
            Export markdown
          </button>
        </div>
        <span className="font-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
          or say &ldquo;export slides&rdquo; / &ldquo;export markdown&rdquo;
        </span>
      </div>
    </div>
  );
}

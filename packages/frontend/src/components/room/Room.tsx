import { useState } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { useSettingsStore } from '../../state/settings-store.js';
import { HermesDiagram } from './HermesDiagram.js';
import { ContentPanel } from './ContentPanel.js';
import { NarrationBar } from './NarrationBar.js';
import { QuickChips } from './QuickChips.js';
import { GapsPanel } from './GapsPanel.js';
import { ListeningPill } from './ListeningPill.js';
import { HistoryRail } from './HistoryRail.js';
import { useHistoryStore } from '../../state/history-store.js';
import { ReviewShelf } from './ReviewShelf.js';
import { useShelfStore } from '../../state/shelf-store.js';
import { CodePanel } from './CodePanel.js';
import { HermesText } from './HermesText.js';
import { useGapsStore } from '../../state/gaps-store.js';
import { SessionEntrance } from './SessionEntrance.js';
// BreadcrumbStrip is gone — its "WHERE / project" label was an orphan
// floating at the top corner. Same info is now in HermesDiagram's title bar.
import { ComprehensionOverlay, ComprehensionToggle } from '../vision/ComprehensionOverlay.js';

/** Room layers, back-to-front:
 *   1. DiagramPanel — the diagram is the centerpiece (was a backdrop;
 *      now the primary visual once Round-A lands).
 *   2. ContentPanel — only for action-required phases (proposal, advisory,
 *      wrap-up, error, analyzing-progress). Narrative phases delegate
 *      their text to HermesText below; the diagram carries the visual.
 *   3. ContentDrawer — side drawer for code snippets, skill results.
 *   4. CodePanel + GapsPanel — slide-in panels.
 *   5. Chrome toolbar.
 *
 * Removed in favor of HermesText:
 *   - BriefingCard overlay (text-heavy; competed with the diagram).
 *   - LiveTranscript right-side panel.
 *   - NarrationBar's line-clamp-2 text portion.
 */

// Phases where Hermes narrates the meaning — the diagram + HermesText
// carry the experience. The legacy ContentPanel prose would fight them.
const NARRATIVE_PHASES = new Set([
  'OVERVIEW', 'AREA_WALKTHROUGH', 'COMPONENT_TOUR', 'PROJECT_OVERVIEW',
  'ARCHITECTURE_OVERVIEW', 'PREVIOUSLY_ON', 'HEATMAP', 'QA',
  'AREA_TRANSITION',
]);

export function Room({ skipEntrance = false }: { skipEntrance?: boolean } = {}) {
  useSession();
  // The entrance cinematic is a multi-second intro that covers the
  // room. The deterministic scene harness skips it so screenshots
  // capture the actual skill state, not the splash. Production default
  // is unchanged (entrance plays).
  const [showEntrance, setShowEntrance] = useState(!skipEntrance);
  const phase = useSessionStore(s => s.state.phase);
  // Show the legacy ContentPanel ONLY for phases that need an action UI
  // (PROPOSAL choices, ANALYZING progress, ADVISORY concerns, WRAP_UP
  // export buttons, ERROR, COMPLETED). Hermes-narrated phases skip it
  // — the diagram is the visual; HermesText is the words.
  const showContentPanel = phase !== 'IDLE' && !NARRATIVE_PHASES.has(phase);
  // PROPOSAL + ANALYZING both let the diagram show through. PROPOSAL
  // gets a full bottom card with the choice UI; ANALYZING gets a
  // small floating progress pill at the top — the diagram-cache warmer
  // means the diagram is usually ready before analysis finishes, so
  // hiding it under a 75% veil throws away the best visual we have.
  // ERROR / WRAP_UP still get the heavy overlay because there's
  // nothing meaningful behind them yet.
  const isProposalFloat = phase === 'PROPOSAL';
  const isAnalyzingFloat = phase === 'ANALYZING';

  return (
    <div className="flex flex-col h-full relative" data-testid="session-room" data-phase={phase}>
      {showEntrance && <SessionEntrance onComplete={() => setShowEntrance(false)} />}

      <div className="flex-1 relative overflow-hidden">
        <HermesDiagram />
        {/* ContentDrawer removed (the right 42% panel blocked the diagram).
            Skill content now flows through HermesText below: caption shows
            the live line; expand reveals the conversation log (and the
            RankedCritiquePanel when critique is active). Diagram-primary,
            voice-primary, transcript-supporting. */}

        {showContentPanel && (
          <div
            className={isProposalFloat || isAnalyzingFloat
              ? 'absolute z-10 overflow-auto pointer-events-none'
              : 'absolute inset-0 z-10 overflow-auto'}
            data-testid="content-panel-wrap"
            data-float={isProposalFloat ? 'proposal' : isAnalyzingFloat ? 'analyzing' : 'none'}
            style={isAnalyzingFloat
              ? {
                  // Top strip — small unobtrusive progress pill above the
                  // diagram. The full Room paints behind it, so the
                  // "Composing diagram…" placeholder stays visible.
                  top: 0, left: 0, right: 0,
                  height: 'auto',
                  background: 'transparent',
                  pointerEvents: 'none',
                }
              : isProposalFloat
              ? {
                  // Bottom card — proposal choices float over the lower
                  // half of the canvas; diagram dominates the upper half.
                  left: 0, right: 0, bottom: 0,
                  maxHeight: '54vh',
                  background: 'linear-gradient(to top, color-mix(in oklch, var(--ink-050) 88%, transparent) 0%, color-mix(in oklch, var(--ink-050) 70%, transparent) 60%, transparent 100%)',
                  backdropFilter: 'blur(8px)',
                  WebkitMaskImage: 'linear-gradient(to top, black 60%, transparent 100%)',
                }
              : {
                  inset: 0,
                  background: 'color-mix(in oklch, var(--ink-050) 75%, transparent)',
                  backdropFilter: 'blur(2px)',
                }}
          >
            <div className={isProposalFloat || isAnalyzingFloat ? 'pointer-events-auto' : ''}>
              <ContentPanel />
            </div>
          </div>
        )}

        {/* Floating mini-toolbar.
         *  Wrapper is pointer-events-none so its EMPTY area doesn't
         *  swallow clicks meant for the diagram header below (the
         *  reason Back was silently registering as Exit before this
         *  fix — same horizontal position, invisible wrapper at z-30
         *  intercepting first).
         *  Buttons re-enable pointer events on themselves and stay
         *  permanently visible at low opacity (was hidden-by-default
         *  with hover:opacity-100, but that doesn't work when the
         *  wrapper can't capture hover — pointer-events-none kills
         *  the :hover trigger). Subtle-by-default is more discoverable
         *  too: the user can SEE Exit/Gaps/Settings exist. */}
        <div className="absolute top-0 left-0 right-0 z-30 pointer-events-none">
          <div className="flex items-center justify-between px-4 py-2 bg-gradient-to-b from-[var(--color-bg)]/80 to-transparent">
            <button
              onClick={() => useSessionStore.getState().resetSession()}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors pointer-events-auto opacity-40 hover:opacity-100"
            >
              &larr; Exit
            </button>
            <div className="flex items-center gap-2 pointer-events-auto opacity-40 hover:opacity-100 transition-opacity">
              <button
                onClick={() => {
                  // Mutually exclusive with HistoryRail — both are
                  // right-side panels; opening one closes the other so
                  // they don't stack invisibly.
                  useHistoryStore.getState().setOpen(false);
                  useGapsStore.getState().toggle();
                }}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                title="Show what you haven't reviewed"
              >
                Gaps
              </button>
              <button
                onClick={() => {
                  useGapsStore.getState().setOpen(false);
                  useHistoryStore.getState().toggle();
                }}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                title="Show conversation history"
              >
                History
              </button>
              <button
                onClick={() => {
                  // Right-side panels are mutually exclusive.
                  useGapsStore.getState().setOpen(false);
                  useHistoryStore.getState().setOpen(false);
                  useShelfStore.getState().setOpen(!useShelfStore.getState().open);
                }}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                title="Notebook, deep dives, tasks, issues, comprehension"
              >
                Shelf
              </button>
              <ComprehensionToggle />
              <button
                onClick={() => useSettingsStore.getState().setSettingsOpen(true)}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              >
                Settings
              </button>
            </div>
          </div>
        </div>

        <GapsPanel />
        <CodePanel />
        <HistoryRail />
        <ReviewShelf />
        <ListeningPill />
      </div>

      <ComprehensionOverlay />

      <QuickChips />
      <HermesText />
      <NarrationBar />
    </div>
  );
}

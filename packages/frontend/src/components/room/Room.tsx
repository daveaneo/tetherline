import { useState } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { useSettingsStore } from '../../state/settings-store.js';
import { DiagramPanel } from './DiagramPanel.js';
import { ContentPanel } from './ContentPanel.js';
import { ContentDrawer } from './ContentDrawer.js';
import { NarrationBar } from './NarrationBar.js';
import { QuickChips } from './QuickChips.js';
import { GapsPanel } from './GapsPanel.js';
import { CodePanel } from './CodePanel.js';
import { HermesText } from './HermesText.js';
import { useGapsStore } from '../../state/gaps-store.js';
import { SessionEntrance } from './SessionEntrance.js';
import { BreadcrumbStrip } from '../vision/BreadcrumbStrip.js';
import { ComprehensionOverlay, ComprehensionToggle } from '../vision/ComprehensionOverlay.js';
import { VERSION } from '../../version.js';

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

export function Room() {
  useSession();
  const [showEntrance, setShowEntrance] = useState(true);
  const phase = useSessionStore(s => s.state.phase);
  // Show the legacy ContentPanel ONLY for phases that need an action UI
  // (PROPOSAL choices, ANALYZING progress, ADVISORY concerns, WRAP_UP
  // export buttons, ERROR, COMPLETED). Hermes-narrated phases skip it
  // — the diagram is the visual; HermesText is the words.
  const showContentPanel = phase !== 'IDLE' && !NARRATIVE_PHASES.has(phase);

  return (
    <div className="flex flex-col h-full relative" data-testid="session-room" data-phase={phase}>
      {showEntrance && <SessionEntrance onComplete={() => setShowEntrance(false)} />}

      <BreadcrumbStrip />

      <div className="flex-1 relative overflow-hidden">
        <DiagramPanel />
        <ContentDrawer />

        {showContentPanel && (
          <div
            className="absolute inset-0 z-10 overflow-auto"
            data-testid="content-panel-wrap"
            style={{
              background: 'color-mix(in oklch, var(--ink-050) 75%, transparent)',
              backdropFilter: 'blur(2px)',
            }}
          >
            <ContentPanel />
          </div>
        )}

        {/* Floating mini-toolbar — appears on hover */}
        <div className="absolute top-0 left-0 right-0 z-30 opacity-0 hover:opacity-100 transition-opacity duration-300">
          <div className="flex items-center justify-between px-4 py-2 bg-gradient-to-b from-[var(--color-bg)]/80 to-transparent">
            <button
              onClick={() => useSessionStore.getState().resetSession()}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              &larr; Exit
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => useGapsStore.getState().toggle()}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                title="Show what you haven't reviewed"
              >
                Gaps
              </button>
              <ComprehensionToggle />
              <span className="text-[10px] text-[var(--color-text-muted)] opacity-50 font-mono">v{VERSION}</span>
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
      </div>

      <ComprehensionOverlay />

      <QuickChips />
      <HermesText />
      <NarrationBar />
    </div>
  );
}

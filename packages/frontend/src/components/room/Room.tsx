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
import { LiveTranscript } from './LiveTranscript.js';
import { MicToggle } from './MicToggle.js';
import { useGapsStore } from '../../state/gaps-store.js';
import { SessionEntrance } from './SessionEntrance.js';
import { BriefingCard } from '../vision/BriefingCard.js';
import { BreadcrumbStrip } from '../vision/BreadcrumbStrip.js';
import { ComprehensionOverlay, ComprehensionToggle } from '../vision/ComprehensionOverlay.js';
import { VERSION } from '../../version.js';

/** Room layers, back-to-front:
 *   1. DiagramPanel — visual backdrop (5 progressive-zoom layers)
 *   2. ContentPanel — phase-aware primary content (analyzing / proposal /
 *      overview / advisory / wrap-up / error / etc.). Guarantees *something*
 *      renders for every non-IDLE phase, so no blank-screen regressions on
 *      any entry mode.
 *   3. ContentDrawer — side drawer for code snippets, skill results
 *   4. BriefingCard — briefing overlay when active
 *   5. Floating chrome toolbar
 */
export function Room() {
  useSession();
  const [showEntrance, setShowEntrance] = useState(true);
  // Code-layer briefings get the dedicated CodePanel UI; the briefing
  // card overlay would just sit on top creating a visual collision, so
  // suppress it for layer === 'code'.
  const briefingLayer = useSessionStore(s => s.currentBriefing?.layer ?? null);
  const hasBriefing = briefingLayer !== null && briefingLayer !== 'code';
  const phase = useSessionStore(s => s.state.phase);
  const showContentPanel = phase !== 'IDLE';

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

        {hasBriefing && (
          <div
            className="absolute inset-0 z-20 overflow-auto"
            data-testid="briefing-overlay"
            style={{
              background: 'color-mix(in oklch, var(--ink-050) 88%, transparent)',
              backdropFilter: 'blur(4px)',
              padding: '48px 32px',
            }}
          >
            <BriefingCard />
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
        <LiveTranscript />
      </div>

      <ComprehensionOverlay />

      <QuickChips />
      <NarrationBar />
    </div>
  );
}

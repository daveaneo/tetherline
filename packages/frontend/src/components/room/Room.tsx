import { useState } from 'react';
import { useSession } from '../../hooks/useSession.js';
import { useSessionStore } from '../../state/session-store.js';
import { useSettingsStore } from '../../state/settings-store.js';
import { DiagramPanel } from './DiagramPanel.js';
import { ContentDrawer } from './ContentDrawer.js';
import { NarrationBar } from './NarrationBar.js';
import { SessionEntrance } from './SessionEntrance.js';
import { BriefingCard } from '../vision/BriefingCard.js';
import { BreadcrumbStrip } from '../vision/BreadcrumbStrip.js';
import { ComprehensionOverlay, ComprehensionToggle } from '../vision/ComprehensionOverlay.js';
import { VERSION } from '../../version.js';

export function Room() {
  useSession();
  const [showEntrance, setShowEntrance] = useState(true);
  const hasBriefing = useSessionStore(s => !!s.currentBriefing);

  return (
    <div className="flex flex-col h-full relative">
      {showEntrance && <SessionEntrance onComplete={() => setShowEntrance(false)} />}

      <BreadcrumbStrip />

      <div className="flex-1 relative overflow-hidden">
        {/* If a briefing is currently active, it takes centre stage over the
            diagram. The diagram stays mounted behind for context + smooth
            transitions back. */}
        <DiagramPanel />
        <ContentDrawer />

        {hasBriefing && (
          <div
            className="absolute inset-0 z-20 overflow-auto"
            style={{
              background: 'color-mix(in oklch, var(--ink-050) 88%, transparent)',
              backdropFilter: 'blur(2px)',
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
      </div>

      <ComprehensionOverlay />

      <NarrationBar />
    </div>
  );
}

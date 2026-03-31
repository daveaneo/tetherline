import { useSession } from '../../hooks/useSession.js';
import { DiagramPanel } from './DiagramPanel.js';
import { ContentPanel } from './ContentPanel.js';
import { NarrationBar } from './NarrationBar.js';

export function Room() {
  useSession();

  return (
    <div className="flex flex-col h-full">
      {/* Main panels */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Architecture Diagram - always visible */}
        <div className="w-[55%] border-r border-[var(--color-border)] relative">
          <DiagramPanel />
        </div>

        {/* Right: Content Panel - morphs based on context */}
        <div className="w-[45%] overflow-y-auto">
          <ContentPanel />
        </div>
      </div>

      {/* Bottom: Narration Bar - always visible */}
      <NarrationBar />
    </div>
  );
}

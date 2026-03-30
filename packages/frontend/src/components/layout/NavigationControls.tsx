import { useSession } from '../../hooks/useSession.js';
import { sendEvent } from '../../lib/ws-client.js';
import { VoiceInput } from '../audio/VoiceInput.js';

export function NavigationControls() {
  const { state } = useSession();

  if (state.phase === 'IDLE' || state.phase === 'ANALYZING') return null;

  return (
    <footer className="flex items-center justify-center gap-3 px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <NavButton onClick={() => sendEvent({ type: 'command:previous' })} label="Previous" shortcut="←" />
      <NavButton
        onClick={() => sendEvent(state.paused ? { type: 'command:resume' } : { type: 'command:pause' })}
        label={state.paused ? 'Resume' : 'Pause'}
        shortcut="Space"
        primary
      />
      <NavButton onClick={() => sendEvent({ type: 'command:next' })} label="Next" shortcut="→" />
      <div className="w-px h-6 bg-[var(--color-border)] mx-2" />
      <NavButton onClick={() => sendEvent({ type: 'command:dive_deeper' })} label="Dive Deeper" shortcut="D" />
      <NavButton onClick={() => sendEvent({ type: 'command:skip' })} label="Skip" shortcut="S" />
      <div className="w-px h-6 bg-[var(--color-border)] mx-2" />
      <VoiceInput />
    </footer>
  );
}

function NavButton({ onClick, label, shortcut, primary }: { onClick: () => void; label: string; shortcut: string; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 text-sm rounded-lg transition-colors ${
        primary
          ? 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white'
          : 'border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      {label}
      <kbd className="text-xs opacity-50">{shortcut}</kbd>
    </button>
  );
}

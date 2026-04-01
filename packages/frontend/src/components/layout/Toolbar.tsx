import { useSettingsStore } from '../../state/settings-store.js';
import { useSessionStore } from '../../state/session-store.js';
import { ModeToggles } from '../settings/ModeToggles.js';
import { VERSION } from '../../version.js';

function ConnectionIndicator() {
  const connected = useSessionStore(s => s.connected);

  return (
    <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
      <span
        className={`w-2 h-2 rounded-full ${
          connected
            ? 'bg-emerald-500'
            : 'bg-amber-500 animate-pulse'
        }`}
      />
      <span>{connected ? 'Connected' : 'Reconnecting'}</span>
    </div>
  );
}

export function Toolbar() {
  const setSettingsOpen = useSettingsStore(s => s.setSettingsOpen);
  const phase = useSessionStore(s => s.state.phase);
  const resetSession = useSessionStore(s => s.resetSession);
  const inSession = phase !== 'IDLE';

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-3">
        {inSession && (
          <button
            onClick={resetSession}
            className="flex items-center gap-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors mr-2"
            title='Back to lobby (or say "exit")'
          >
            <span className="text-base">&larr;</span>
            <span>Exit</span>
          </button>
        )}
        <h1 className="text-lg font-semibold tracking-tight">Interactive Reviewer</h1>
        <span className="text-[10px] text-[var(--color-text-muted)] opacity-50 font-mono">v{VERSION}</span>
        <ConnectionIndicator />
      </div>
      <div className="flex items-center gap-4">
        {inSession && <ModeToggles />}
        <button
          onClick={() => setSettingsOpen(true)}
          className="px-3 py-1.5 text-sm rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
        >
          Settings
        </button>
      </div>
    </header>
  );
}

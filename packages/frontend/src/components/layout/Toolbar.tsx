import { useSettingsStore } from '../../state/settings-store.js';
import { useSessionStore } from '../../state/session-store.js';
import { ModeToggles } from '../settings/ModeToggles.js';
import { VERSION } from '../../version.js';

function ConnectionIndicator() {
  const connected = useSessionStore(s => s.connected);
  return (
    <div className="chrome-meta">
      <span className={`ping ${connected ? '' : 'is-warn'}`} />
      <span>{connected ? 'connected' : 'reconnecting'}</span>
      <span className="hidden md:inline" style={{ opacity: 0.5 }}>·</span>
      <span className="hidden md:inline" style={{ opacity: 0.5 }}>v{VERSION}</span>
    </div>
  );
}

export function Toolbar() {
  const setSettingsOpen = useSettingsStore(s => s.setSettingsOpen);
  const phase = useSessionStore(s => s.state.phase);
  const resetSession = useSessionStore(s => s.resetSession);
  const inSession = phase !== 'IDLE';

  return (
    <header className="chrome">
      <div className="flex items-center gap-4">
        {inSession && (
          <button
            type="button"
            onClick={resetSession}
            className="chrome-tab"
            title='Back to lobby (or say "exit")'
          >
            <span style={{ fontSize: 14 }}>←</span>
            <span>Exit</span>
          </button>
        )}
        <div className="chrome-brand">
          <span className="dot" />
          <span>Interactive Reviewer</span>
        </div>
      </div>

      <div>
        {inSession && <ModeToggles />}
      </div>

      <div className="flex items-center gap-3">
        <ConnectionIndicator />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="chrome-tab"
        >
          Settings
        </button>
      </div>
    </header>
  );
}

import { AppShell } from './components/layout/AppShell.js';
import { Lobby } from './components/lobby/Lobby.js';
import { SessionView } from './components/session/SessionView.js';
import { Toolbar } from './components/layout/Toolbar.js';
import { NavigationControls } from './components/layout/NavigationControls.js';
import { ProgressBar } from './components/layout/ProgressBar.js';
import { SettingsPanel } from './components/settings/SettingsPanel.js';
import { ErrorBanner } from './components/layout/ErrorBanner.js';
import { QuestionPanel } from './components/session/QuestionPanel.js';
import { NarrationPlayer } from './components/audio/NarrationPlayer.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useSessionOrchestrator } from './hooks/useSessionOrchestrator.js';
import { useSessionStore } from './state/session-store.js';

export function App() {
  const { connected, reconnecting } = useWebSocket();
  const phase = useSessionStore(s => s.state.phase);
  const inSession = phase !== 'IDLE';

  useKeyboardShortcuts();
  useSessionOrchestrator();

  if (!connected && !reconnecting) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="animate-pulse text-lg text-zinc-400">Connecting...</div>
            <p className="text-sm text-zinc-600 mt-2">Waiting for the server at localhost</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (reconnecting) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="animate-pulse text-lg text-amber-400">Reconnecting...</div>
            <p className="text-sm text-zinc-500 mt-2">Connection lost, attempting to reconnect</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Toolbar />
      <ErrorBanner />
      {inSession && <ProgressBar />}
      <main className="flex-1 overflow-hidden">
        {inSession ? <SessionView /> : <Lobby />}
      </main>
      {inSession && <NavigationControls />}
      {inSession && <NarrationPlayer />}
      <QuestionPanel />
      <SettingsPanel />
    </AppShell>
  );
}

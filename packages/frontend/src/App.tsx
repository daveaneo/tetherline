import { AppShell } from './components/layout/AppShell.js';
import { SessionView } from './components/session/SessionView.js';
import { Toolbar } from './components/layout/Toolbar.js';
import { ErrorBanner } from './components/layout/ErrorBanner.js';
import { NavigationControls } from './components/layout/NavigationControls.js';
import { ProgressBar } from './components/layout/ProgressBar.js';
import { SettingsPanel } from './components/settings/SettingsPanel.js';
import { QuestionPanel } from './components/session/QuestionPanel.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';

export function App() {
  const { connected, reconnecting } = useWebSocket();
  useKeyboardShortcuts();

  return (
    <AppShell>
      <Toolbar />
      <ErrorBanner />
      <ProgressBar />
      <main className="flex-1 overflow-hidden">
        {connected ? (
          <SessionView />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="animate-pulse text-lg text-zinc-400">
                {reconnecting ? 'Reconnecting...' : 'Connecting...'}
              </div>
              {reconnecting && (
                <div className="text-sm text-zinc-500 mt-2">
                  Connection lost. Attempting to reconnect...
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      <NavigationControls />
      <SettingsPanel />
      <QuestionPanel />
    </AppShell>
  );
}

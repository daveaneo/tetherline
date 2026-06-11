import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell.js';
import { Lobby } from './components/lobby/Lobby.js';
import { Room } from './components/room/Room.js';
import { Toolbar } from './components/layout/Toolbar.js';
import { SettingsPanel } from './components/settings/SettingsPanel.js';
import { ErrorBanner } from './components/layout/ErrorBanner.js';
import { SpeechToasts } from './components/audio/SpeechToasts.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
// useInterrupt is intentionally NOT used: its "any keypress = interrupt"
// sledgehammer pauses the session when the user presses Cmd+C to copy
// briefing text. Explicit PTT (hold space) handles intentional
// interrupts; ambient interrupts are gone now that the mic is off by
// default. Keep the file around as a reference, but don't mount it.
import { useSessionOrchestrator } from './hooks/useSessionOrchestrator.js';
import { useVoiceInput } from './hooks/useVoiceInput.js';
import { useSessionStore } from './state/session-store.js';
import { sendEvent } from './lib/ws-client.js';
import type { EntryMode } from '@tetherline/shared';

export function App() {
  const { connected, reconnecting } = useWebSocket();
  const phase = useSessionStore(s => s.state.phase);
  const inSession = phase !== 'IDLE';
  const deepLinkHandled = useRef(false);

  // Handle deep links from digest emails (e.g. ?repo=/path&mode=updates)
  useEffect(() => {
    if (!connected || deepLinkHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const repo = params.get('repo');
    const mode = params.get('mode');
    if (repo && mode) {
      deepLinkHandled.current = true;
      useSessionStore.setState({ activeRepoPath: repo });
      sendEvent({ type: 'session:start', payload: { repoPath: repo, sinceDays: 7, entryMode: mode as EntryMode } });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [connected]);

  useKeyboardShortcuts();
  useSessionOrchestrator();
  useVoiceInput();

  // Full-screen connection states ONLY outside a session. Mid-session, a
  // network blip must NOT unmount the Room — that destroyed all Room-local
  // state (diagram scope, panels) and replayed the entrance splash on
  // remount. In-session disconnects render a small overlay pill instead;
  // useWebSocket auto-resumes the session when the socket comes back.
  if (!inSession && !connected) {
    return (
      <AppShell>
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <div className="animate-pulse font-serif" style={{ fontSize: 20, fontStyle: 'italic', color: reconnecting ? 'var(--amber-400)' : 'var(--cream-600)' }}>
              {reconnecting ? 'Reconnecting…' : 'Connecting…'}
            </div>
            <p className="mt-2 font-mono" style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
              {reconnecting ? 'Connection lost — retrying' : 'Waiting for the server at localhost'}
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      {!inSession && <Toolbar />}
      <ErrorBanner />
      <main className={`flex-1 ${inSession ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        {inSession ? <Room /> : <Lobby />}
      </main>
      {inSession && !connected && <ReconnectPill />}
      <SpeechToasts />
      <SettingsPanel />
    </AppShell>
  );
}

/** Non-blocking reconnect indicator — the Room stays mounted and visible
 *  underneath. The session auto-resumes on reconnect (useWebSocket). */
function ReconnectPill() {
  return (
    <div
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none flex items-center gap-2"
      style={{
        padding: '8px 16px',
        borderRadius: 999,
        background: 'color-mix(in oklch, var(--ink-100) 92%, transparent)',
        border: '1px solid color-mix(in oklch, var(--amber-500) 40%, transparent)',
        backdropFilter: 'blur(12px)',
        boxShadow: 'var(--shadow-2)',
      }}
      data-testid="reconnect-pill"
      role="status"
    >
      <span
        className="animate-pulse"
        style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber-400)', boxShadow: '0 0 8px var(--amber-400)' }}
      />
      <span className="font-mono" style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--amber-200)' }}>
        Reconnecting…
      </span>
    </div>
  );
}

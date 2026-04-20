/**
 * Deep-link handler: App.tsx parses `?repo=&mode=` on mount when connected,
 * auto-starts a session, and strips the query string. This test proves the
 * parsing + dispatch wire-up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from '../../packages/frontend/src/App.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';

const sendEventMock = vi.hoisted(() => vi.fn());
vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: sendEventMock }));

// The useWebSocket hook tries to connect. Stub it to report connected.
vi.mock('../../packages/frontend/src/hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ connected: true, reconnecting: false }),
}));
vi.mock('../../packages/frontend/src/hooks/useKeyboardShortcuts.js', () => ({ useKeyboardShortcuts: () => {} }));
vi.mock('../../packages/frontend/src/hooks/useInterrupt.js', () => ({ useInterrupt: () => {} }));
vi.mock('../../packages/frontend/src/hooks/useSessionOrchestrator.js', () => ({ useSessionOrchestrator: () => {} }));
vi.mock('../../packages/frontend/src/hooks/useVoiceInput.js', () => ({ useVoiceInput: () => {} }));

vi.mock('../../packages/frontend/src/lib/api-client.js', () => ({
  api: {
    listRepos: vi.fn().mockResolvedValue({ repos: [] }),
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    health: vi.fn().mockResolvedValue({ hasAnthropicKey: true, hasOpenaiKey: false }),
  },
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
});

describe('Deep-link handling on App mount', () => {
  beforeEach(() => {
    sendEventMock.mockReset();
    cleanup();
    // Reset URL to clean slate
    window.history.replaceState({}, '', '/');
    useSessionStore.setState({ state: { phase: 'IDLE' } as any, activeRepoPath: '' });
  });

  it('parses ?repo=&mode= and dispatches session:start, then strips the query', async () => {
    window.history.replaceState({}, '', '/?repo=/tmp/mine&mode=updates');

    render(<App />);

    await waitFor(() => {
      expect(sendEventMock).toHaveBeenCalledWith(expect.objectContaining({
        type: 'session:start',
        payload: expect.objectContaining({
          repoPath: '/tmp/mine',
          entryMode: 'updates',
        }),
      }));
    });

    // Query string stripped
    expect(window.location.search).toBe('');
    // activeRepoPath set in store
    expect(useSessionStore.getState().activeRepoPath).toBe('/tmp/mine');
  });

  it('does NOT dispatch session:start when there are no deep-link params', async () => {
    render(<App />);
    // give any effect a tick
    await new Promise(r => setTimeout(r, 50));
    const startCalls = sendEventMock.mock.calls.filter(c => (c[0] as any)?.type === 'session:start');
    expect(startCalls).toHaveLength(0);
  });

  it('handles malformed deep-link gracefully (no crash, no session start)', async () => {
    window.history.replaceState({}, '', '/?repo=');
    render(<App />);
    await new Promise(r => setTimeout(r, 50));
    const startCalls = sendEventMock.mock.calls.filter(c => (c[0] as any)?.type === 'session:start');
    expect(startCalls).toHaveLength(0);
  });
});

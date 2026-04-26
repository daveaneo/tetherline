/**
 * CodePanel — opens when a code-layer briefing is active. Fetches the
 * file's content and renders it line-by-line with line numbers. The
 * close button sends `command:level_up` to pop the briefing off the
 * navigator.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CodePanel } from '../../packages/frontend/src/components/room/CodePanel.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';

const sentEvents: any[] = [];
vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({
  sendEvent: vi.fn((e: any) => { sentEvents.push(e); }),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  sentEvents.length = 0;
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/repos/file')) {
      return {
        ok: true,
        json: async () => ({
          path: 'src/auth.ts',
          content: 'function issueToken() {\n  return "tok";\n}\n',
          sizeBytes: 42,
        }),
      } as any;
    }
    return originalFetch(url);
  }) as any;

  // Reset store to a fresh state.
  useSessionStore.setState({
    ...useSessionStore.getState(),
    activeRepoPath: '/tmp/fixture',
    currentBriefing: null,
  } as any);
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe('CodePanel', () => {
  it('renders nothing when there is no briefing', () => {
    const { container } = render(<CodePanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for non-code briefings', () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      currentBriefing: {
        briefingId: 'module/auth', layer: 'module', title: 'Auth',
        text: '...', estimatedSeconds: 20, talkingPoints: [], children: [],
        parent: 'arch/root', resumePrefix: undefined, receivedAt: Date.now(),
      },
    } as any);
    const { container } = render(<CodePanel />);
    expect(container.firstChild).toBeNull();
  });

  it('opens for a code-layer briefing and fetches the file content', async () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      currentBriefing: {
        briefingId: 'code/src/auth.ts:issueToken',
        layer: 'code',
        title: 'issueToken (auth.ts)',
        text: 'Walking through issueToken…',
        estimatedSeconds: 25,
        talkingPoints: ['Function issueToken — issues a JWT'],
        children: [],
        parent: 'file/src/auth.ts',
        receivedAt: Date.now(),
      },
    } as any);

    render(<CodePanel />);
    expect(screen.getByTestId('code-panel')).toBeInTheDocument();

    // The fetch should have been issued with the right query.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/repos/file?repoPath=%2Ftmp%2Ffixture&path=src%2Fauth.ts'),
    );

    // Wait for content to render.
    await waitFor(() => {
      expect(screen.getByTestId('code-panel-source')).toBeInTheDocument();
    });
    // The function definition should appear, line-numbered.
    expect(screen.getByText(/function issueToken/)).toBeInTheDocument();
  });

  it('close button sends command:level_up', async () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      currentBriefing: {
        briefingId: 'code/src/auth.ts:issueToken',
        layer: 'code',
        title: 'issueToken (auth.ts)',
        text: '…', estimatedSeconds: 20, talkingPoints: [], children: [],
        parent: 'file/src/auth.ts', receivedAt: Date.now(),
      },
    } as any);

    render(<CodePanel />);
    const closeBtn = screen.getByTestId('code-panel-close');
    closeBtn.click();
    expect(sentEvents).toContainEqual({ type: 'command:level_up' });
  });

  it('renders an error message when the fetch fails', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'file not found' }),
    })) as any;
    useSessionStore.setState({
      ...useSessionStore.getState(),
      currentBriefing: {
        briefingId: 'code/src/missing.ts',
        layer: 'code',
        title: 'missing.ts',
        text: '…', estimatedSeconds: 20, talkingPoints: [], children: [],
        parent: 'file/src/missing.ts', receivedAt: Date.now(),
      },
    } as any);

    render(<CodePanel />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load file/)).toBeInTheDocument();
    });
  });
});

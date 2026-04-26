/**
 * GapsPanel — "Pick up where you left off" rich recall items.
 * Each item shows label, level badge, and commits-since-last-touch hint.
 * Clicking sends "tell me about <label>" so the user resumes naturally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GapsPanel } from '../../packages/frontend/src/components/room/GapsPanel.js';
import { useGapsStore } from '../../packages/frontend/src/state/gaps-store.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';

const sentEvents: any[] = [];
vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({
  sendEvent: vi.fn((e: any) => { sentEvents.push(e); }),
}));

beforeEach(() => {
  sentEvents.length = 0;
  useGapsStore.setState({ open: true, setOpen: useGapsStore.getState().setOpen, toggle: useGapsStore.getState().toggle });
  useSessionStore.setState({
    ...useSessionStore.getState(),
    activeRepoPath: '/tmp/fixture',
    areas: [],
    state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
    comprehensionMap: new Map(),
    recallQuestions: [],
    recallItems: [],
  } as any);
});

afterEach(() => {
  cleanup();
});

describe('GapsPanel — recall items', () => {
  it('renders the "Pick up where you left off" section when items are present', () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      recallItems: [
        { itemId: 'module/auth', label: 'auth', layer: 'module', level: 'explained' as const, commitsSinceLastTouch: 3 },
        { itemId: 'module/payments', label: 'payments', layer: 'module', level: 'engaged' as const, commitsSinceLastTouch: 0 },
      ],
    } as any);

    render(<GapsPanel />);
    expect(screen.getByTestId('recall-items')).toBeInTheDocument();
    expect(screen.getByText('auth')).toBeInTheDocument();
    expect(screen.getByText('payments')).toBeInTheDocument();
    // Drift hint reflects actual commit count.
    expect(screen.getByText(/3 commits touched it since/)).toBeInTheDocument();
    expect(screen.getByText(/nothing has changed since/)).toBeInTheDocument();
    // Level badges visible.
    expect(screen.getByText('explained')).toBeInTheDocument();
    expect(screen.getByText('engaged')).toBeInTheDocument();
  });

  it('clicking a recall item sends "tell me about X" and closes the panel', () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      recallItems: [
        { itemId: 'module/auth', label: 'auth', layer: 'module', level: 'explained' as const, commitsSinceLastTouch: 1 },
      ],
    } as any);

    render(<GapsPanel />);
    const button = screen.getByText('auth').closest('button')!;
    fireEvent.click(button);

    expect(sentEvents.some(e =>
      e.type === 'user:utterance' && e.payload.text === 'tell me about auth',
    )).toBe(true);
    // Panel closes after pick.
    expect(useGapsStore.getState().open).toBe(false);
  });

  it('does not render the section when there are no recall items', () => {
    render(<GapsPanel />);
    expect(screen.queryByTestId('recall-items')).not.toBeInTheDocument();
  });

  it('singular vs plural commit text for 1 commit', () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      recallItems: [
        { itemId: 'module/auth', label: 'auth', layer: 'module', level: 'explained' as const, commitsSinceLastTouch: 1 },
      ],
    } as any);
    render(<GapsPanel />);
    expect(screen.getByText(/1 commit touched it since/)).toBeInTheDocument();
    expect(screen.queryByText(/1 commits/)).not.toBeInTheDocument();
  });
});

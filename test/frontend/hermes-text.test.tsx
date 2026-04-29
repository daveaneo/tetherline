/**
 * HermesText — single text surface for everything Hermes says.
 * Replaces BriefingCard + LiveTranscript + NarrationBar's clamped text.
 *
 * Behavior under test:
 *   • Collapsed by default; shows the live line in full (no ellipsis).
 *   • Expand button reveals the conversation log with auto-scroll.
 *   • Hidden on the IDLE phase (lobby).
 *   • Live line follows currentStreamChunk → next-queued → currentBriefing
 *     → most recent AI conversation entry, in that priority.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HermesText } from '../../packages/frontend/src/components/room/HermesText.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';

vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn() }));

beforeEach(() => {
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: false } as any,
    conversationHistory: [],
    streamChunks: [],
    currentStreamChunk: null,
    currentBriefing: null,
  } as any);
});

afterEach(() => cleanup());

describe('HermesText', () => {
  it('renders nothing on the IDLE lobby phase', () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      state: { phase: 'IDLE' } as any,
      conversationHistory: [{ speaker: 'ai', text: 'hi', timestamp: 1 }],
    } as any);
    const { container } = render(<HermesText />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there is no content yet', () => {
    const { container } = render(<HermesText />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the currently-spoken stream chunk in full (no truncation)', () => {
    const longLine = 'The capture pipeline funnels every payment through an idempotency guard before any external side effects, which means a network retry never double-charges, even under flapping connections.';
    useSessionStore.setState({
      ...useSessionStore.getState(),
      currentStreamChunk: { streamId: 's1', seq: 0, text: longLine },
    } as any);
    render(<HermesText />);
    // Full text present — no ellipsis substring.
    expect(screen.getByText(longLine)).toBeInTheDocument();
    expect(screen.queryByText(/…$/)).not.toBeInTheDocument();
    // Default state is collapsed (Log expand affordance visible).
    expect(screen.getByTestId('hermes-text-expand')).toBeInTheDocument();
    expect(screen.getByTestId('hermes-text')).toHaveAttribute('data-expanded', 'false');
  });

  it('falls back through the priority chain: stream chunk → briefing → conversation', () => {
    // No stream chunk, no briefing — should pick most recent AI entry.
    useSessionStore.setState({
      ...useSessionStore.getState(),
      conversationHistory: [
        { speaker: 'you', text: 'what is auth?', timestamp: 1 },
        { speaker: 'ai', text: 'auth issues short-lived JWTs.', timestamp: 2 },
      ],
    } as any);
    render(<HermesText />);
    expect(screen.getByText('auth issues short-lived JWTs.')).toBeInTheDocument();
  });

  it('expand → shows full conversation log with both speakers', () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      conversationHistory: [
        { speaker: 'ai', text: 'PersonalForge bakes docs into weights.', timestamp: 1 },
        { speaker: 'you', text: 'tell me about training', timestamp: 2 },
        { speaker: 'ai', text: 'Training owns the fine-tuning loop.', timestamp: 3 },
      ],
    } as any);
    render(<HermesText />);
    fireEvent.click(screen.getByTestId('hermes-text-expand'));

    expect(screen.getByTestId('hermes-text')).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByText(/PersonalForge bakes docs/)).toBeInTheDocument();
    expect(screen.getByText('tell me about training')).toBeInTheDocument();
    expect(screen.getByText(/Training owns the fine-tuning loop/)).toBeInTheDocument();
    expect(screen.getByTestId('hermes-text-collapse')).toBeInTheDocument();
  });

  it('collapse → returns to single-line live view', () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      conversationHistory: [{ speaker: 'ai', text: 'a reply', timestamp: 1 }],
    } as any);
    render(<HermesText />);
    fireEvent.click(screen.getByTestId('hermes-text-expand'));
    fireEvent.click(screen.getByTestId('hermes-text-collapse'));
    expect(screen.getByTestId('hermes-text')).toHaveAttribute('data-expanded', 'false');
  });
});

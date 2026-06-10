/**
 * ArtifactCard: the copyable code/commands card that replaces "the AI
 * reads the script aloud". Store handler + copy + dismiss + replace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ArtifactCard } from '../../packages/frontend/src/components/room/ArtifactCard.js';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';

vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn() }));

const BODY = 'git clone repo\ncd repo\nnpm install';

function emitArtifact(id = 'qa-1-a0', body = BODY) {
  useSessionStore.getState().handleServerEvent({
    type: 'visual:artifact',
    payload: { id, kind: 'commands', language: 'bash', body },
  } as any);
}

beforeEach(() => {
  useSessionStore.setState({ ...useSessionStore.getState(), activeArtifact: null } as any);
});

afterEach(() => cleanup());

describe('ArtifactCard', () => {
  it('renders nothing without an artifact', () => {
    render(<ArtifactCard />);
    expect(screen.queryByTestId('artifact-card')).toBeNull();
  });

  it('visual:artifact event renders the card with selectable body', () => {
    render(<ArtifactCard />);
    act(() => emitArtifact());
    const card = screen.getByTestId('artifact-card');
    expect(card.textContent).toContain('git clone repo');
    expect(card.textContent).toContain('bash');
  });

  it('Copy puts the exact body on the clipboard and shows feedback', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<ArtifactCard />);
    act(() => emitArtifact());
    fireEvent.click(screen.getByTestId('artifact-copy'));
    await act(async () => { await Promise.resolve(); });

    expect(writeText).toHaveBeenCalledWith(BODY);
    expect(screen.getByTestId('artifact-copy').textContent).toContain('Copied');
  });

  it('a new artifact replaces the old card', () => {
    render(<ArtifactCard />);
    act(() => emitArtifact('a1', 'npm run dev'));
    act(() => emitArtifact('a2', 'pnpm verify'));
    const card = screen.getByTestId('artifact-card');
    expect(card.textContent).toContain('pnpm verify');
    expect(card.textContent).not.toContain('npm run dev');
  });

  it('duplicate event ids are deduped (WS replay)', () => {
    render(<ArtifactCard />);
    act(() => emitArtifact('same-id', 'first'));
    const before = useSessionStore.getState().activeArtifact;
    act(() => emitArtifact('same-id', 'second'));
    expect(useSessionStore.getState().activeArtifact).toBe(before);
  });

  it('dismiss clears the card', () => {
    render(<ArtifactCard />);
    act(() => emitArtifact());
    fireEvent.click(screen.getByTestId('artifact-dismiss'));
    expect(screen.queryByTestId('artifact-card')).toBeNull();
    expect(useSessionStore.getState().activeArtifact).toBeNull();
  });
});

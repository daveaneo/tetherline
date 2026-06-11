/**
 * Lobby rendering states — every branch the user can land on from a cold load.
 * Proves the "empty state → add repo", "repo list → begin session", and
 * "entry mode dialog" paths all produce visible, actionable UI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Lobby } from '../../packages/frontend/src/components/lobby/Lobby.js';

const apiMock = vi.hoisted(() => ({
  listRepos: vi.fn(),
  getRepo: vi.fn(),
  listSessions: vi.fn(),
  health: vi.fn(),
  addRepo: vi.fn(),
}));
vi.mock('../../packages/frontend/src/lib/api-client.js', () => ({ api: apiMock }));
vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn(() => true) }));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
});

const sampleRepo = {
  id: 'r1', path: '/tmp/myrepo', name: 'myrepo',
  addedAt: '2026-04-01T00:00:00Z', lastReviewedAt: '2026-04-18T00:00:00Z',
  totalSessions: 3, understandingPct: 62,
  newCommits: 12, contributors: ['alice', 'bob'],
};

describe('Lobby rendering states', () => {
  beforeEach(() => {
    apiMock.listRepos.mockReset();
    apiMock.getRepo.mockReset();
    apiMock.listSessions.mockReset();
    apiMock.health.mockReset();
    apiMock.addRepo.mockReset();
    apiMock.health.mockResolvedValue({ hasAnthropicKey: true, hasOpenaiKey: false });
    apiMock.listSessions.mockResolvedValue({ sessions: [] });
  });
  afterEach(() => cleanup());

  it('shows the loading state initially, then the hero + empty state when no repos', async () => {
    apiMock.listRepos.mockResolvedValue({ repos: [] });

    const { container } = render(<Lobby />);
    // Loading is now a skeleton (R6): hero renders immediately, repo
    // rows shimmer — no bare "Reading your repositories…" text line.
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(container.querySelector('.lobby-hero')).toBeInTheDocument();
    });
    expect(screen.getByText(/No repositories yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add your first repository/i })).toBeInTheDocument();
  });

  it('renders the repo list with window picker when repos exist', async () => {
    apiMock.listRepos.mockResolvedValue({ repos: [sampleRepo] });
    apiMock.getRepo.mockResolvedValue(sampleRepo);

    const { container } = render(<Lobby />);
    // wait for the repo-meta .n element to appear
    await waitFor(() => {
      expect(container.querySelector('.repo-meta .n')).toHaveTextContent('myrepo');
    });

    const picker = container.querySelector('.window-picker');
    expect(picker).toBeInTheDocument();
    expect(picker!.querySelectorAll('.window-pill').length).toBe(4);

    expect(screen.getByRole('button', { name: /Begin session/i })).toBeInTheDocument();
  });

  it('shows amber warning when Anthropic API key is missing', async () => {
    apiMock.health.mockResolvedValue({ hasAnthropicKey: false, hasOpenaiKey: false });
    apiMock.listRepos.mockResolvedValue({ repos: [sampleRepo] });
    apiMock.getRepo.mockResolvedValue(sampleRepo);

    render(<Lobby />);
    await waitFor(() => {
      expect(screen.getByText(/No Anthropic API key detected/i)).toBeInTheDocument();
    });
  });

  it('opens entry mode dialog with all 4 modes when "Begin session" clicked', async () => {
    apiMock.listRepos.mockResolvedValue({ repos: [sampleRepo] });
    apiMock.getRepo.mockResolvedValue(sampleRepo);

    const { container } = render(<Lobby />);
    await waitFor(() => {
      expect(container.querySelector('.repo-meta .n')).toHaveTextContent('myrepo');
    });

    fireEvent.click(screen.getByRole('button', { name: /Begin session/i }));

    await waitFor(() => {
      expect(screen.getByText(/How should we open/i)).toBeInTheDocument();
    });
    // All four mode cards render — use getAllByText for matches that repeat
    // (e.g. "Full walkthrough" appears in both a title and a voice hint).
    expect(screen.getAllByText(/Full walkthrough/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Updates only/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Onboarding program/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Explore$/).length).toBeGreaterThanOrEqual(1);
  });

  it('opens add-repo dialog with an input field', async () => {
    apiMock.listRepos.mockResolvedValue({ repos: [sampleRepo] });
    apiMock.getRepo.mockResolvedValue(sampleRepo);

    const { container } = render(<Lobby />);
    await waitFor(() => {
      expect(container.querySelector('.repo-meta .n')).toHaveTextContent('myrepo');
    });

    // There's an "+ Add repository" button near the list
    const buttons = screen.getAllByRole('button').filter(b => /Add repository/i.test(b.textContent ?? ''));
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]);

    await waitFor(() => {
      expect(screen.getByText(/Point us at a repo/i)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/github.com\/user\/repo/i)).toBeInTheDocument();
  });

  it('shows Recent sessions list when past sessions have activity', async () => {
    apiMock.listRepos.mockResolvedValue({ repos: [sampleRepo] });
    apiMock.getRepo.mockResolvedValue(sampleRepo);
    apiMock.listSessions.mockResolvedValue({
      sessions: [
        { id: 's1', repoName: 'myrepo', startedAt: '2026-04-15T10:00:00Z', totalAreas: 5, totalCommits: 20, summary: 'Last week covered payments.' },
      ],
    });

    const { container } = render(<Lobby />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/Recent sessions/i);
    });
    expect(container.textContent).toMatch(/Last week covered payments/i);
  });
});

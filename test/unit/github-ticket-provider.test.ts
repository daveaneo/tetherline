/**
 * GitHubTicketProvider dry-run path — exercises the call shape end-to-
 * end without hitting the network. The real GitHub creation happens
 * via the `gh` CLI when available; this test guards the structured
 * fallback so the rest of the app can rely on a well-formed response
 * even offline / in CI.
 */
import { describe, it, expect } from 'vitest';
import { GitHubTicketProvider } from '../../packages/backend/src/integrations/github-provider.js';

describe('GitHubTicketProvider — dry-run', () => {
  it('returns a structured CreateTicketResult marked github-dryrun', async () => {
    const provider = new GitHubTicketProvider({ dryRun: true });
    const result = await provider.createTicket({
      title: 'Refactor capture pipeline',
      body: 'Break the idempotency guard out of capture.ts so it can be tested in isolation.',
      labels: ['tech-debt'],
      projectRef: 'acme/payments',
    });
    expect(result.provider).toBe('github-dryrun');
    expect(result.url).toMatch(/^https:\/\/github\.com\/acme\/payments\/issues\/dry-run-/);
    expect(result.externalId).toBe('dry-run');
  });

  it('reports as configured (real probe is async, so optimistic)', () => {
    const provider = new GitHubTicketProvider({ dryRun: true });
    expect(provider.isConfigured()).toBe(true);
    expect(provider.name).toBe('github');
  });

  it('handles labels + assignee shape without exploding', async () => {
    // Even in dry-run, the request shape is the same as a real call —
    // exercising the full surface guards against future breakage.
    const provider = new GitHubTicketProvider({ dryRun: true });
    const result = await provider.createTicket({
      title: 't',
      body: 'b',
      labels: ['a', 'b', 'c'],
      assignee: 'octocat',
      projectRef: 'a/b',
    });
    expect(result).toBeTruthy();
    expect(result.provider).toMatch(/github/);
  });
});

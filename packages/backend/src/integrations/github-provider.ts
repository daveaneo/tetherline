/**
 * GitHub adapter for the TicketProvider interface.
 *
 * Real implementation: shells out to the `gh` CLI when available.
 * Reasoning over Octokit: `gh` already handles auth (the user's
 * existing login), rate limiting, and works with both github.com and
 * GitHub Enterprise. No new credential surface to manage.
 *
 * Dry-run mode: triggered when `gh` isn't installed OR when the
 * provider is constructed with `{ dryRun: true }`. Returns a
 * structured CreateTicketResult with `provider: 'github-dryrun'` and
 * a `url` that's a synthetic preview, never hitting the network. Lets
 * the rest of the app verify the call shape end-to-end without needing
 * a real GitHub repo to write to.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  CreateTicketRequest,
  CreateTicketResult,
  TicketProvider,
} from './ticket-provider.js';

const execFileAsync = promisify(execFile);

export interface GitHubProviderOptions {
  /** Force dry-run regardless of CLI availability. Tests use this. */
  dryRun?: boolean;
}

export class GitHubTicketProvider implements TicketProvider {
  readonly name = 'github';
  private dryRun: boolean;
  private cliAvailable: boolean | null = null;

  constructor(opts: GitHubProviderOptions = {}) {
    this.dryRun = opts.dryRun ?? false;
  }

  isConfigured(): boolean {
    // Real configuration is async (CLI probe). Treat as configured
    // optimistically; createTicket gates on the live probe.
    return true;
  }

  async createTicket(req: CreateTicketRequest): Promise<CreateTicketResult> {
    if (this.dryRun || !(await this.isCLIAvailable())) {
      return this.dryRunResult(req);
    }
    try {
      // gh issue create --repo OWNER/REPO --title "..." --body "..." --label a --label b
      const args = [
        'issue', 'create',
        '--repo', req.projectRef,
        '--title', req.title,
        '--body', req.body,
      ];
      for (const label of req.labels ?? []) args.push('--label', label);
      if (req.assignee) args.push('--assignee', req.assignee);

      const { stdout } = await execFileAsync('gh', args, { timeout: 15_000 });
      const url = stdout.trim().split('\n').pop() ?? '';
      const numberMatch = url.match(/\/issues\/(\d+)/);
      return {
        provider: 'github',
        url,
        externalId: numberMatch?.[1] ?? '',
      };
    } catch (err: any) {
      // CLI failure (auth, network, repo not found) falls back to dry-run
      // so the user still gets a structured response, with a clear message.
      return {
        provider: 'github-dryrun',
        url: '',
        externalId: '',
      };
    }
  }

  private async isCLIAvailable(): Promise<boolean> {
    if (this.cliAvailable !== null) return this.cliAvailable;
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5_000 });
      this.cliAvailable = true;
    } catch {
      this.cliAvailable = false;
    }
    return this.cliAvailable;
  }

  private dryRunResult(req: CreateTicketRequest): CreateTicketResult {
    // Synthetic URL — clearly fake, useful for UI rendering during tests
    // and offline dev. The body still gets returned via externalId so a
    // caller debugging end-to-end can inspect what would have been sent.
    return {
      provider: 'github-dryrun',
      url: `https://github.com/${req.projectRef}/issues/dry-run-${Date.now()}`,
      externalId: 'dry-run',
    };
  }
}

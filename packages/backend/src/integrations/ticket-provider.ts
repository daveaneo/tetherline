/**
 * TicketProvider — pluggable interface for "create issue / ticket from
 * here" actions. Implementations live alongside this file:
 *   - github-provider.ts (later)
 *   - linear-provider.ts (later)
 *   - jira-provider.ts (later)
 *
 * The default implementation is a no-op stub so the seam exists across
 * the codebase before any real provider lands. Code-layer briefings can
 * already wire a "Create ticket" affordance that resolves this provider
 * — no re-architect when GitHub/Linear/Jira ship.
 */

export interface CreateTicketRequest {
  /** Short title — usually the file/symbol or briefing title. */
  title: string;
  /** Markdown body describing context: briefing summary, file path,
   *  optional code snippet, repo path. */
  body: string;
  /** Provider-side labels (e.g. ["tech-debt", "tetherline"]). */
  labels?: string[];
  /** Optional: which user (or assignee) to attribute the ticket to. */
  assignee?: string;
  /** Repo / project identifier in the upstream system. For GitHub
   *  "owner/repo"; for Linear, the team key; for Jira, the project key. */
  projectRef: string;
}

export interface CreateTicketResult {
  /** Provider name ("github" | "linear" | "jira" | "noop"). */
  provider: string;
  /** Display URL. Empty string for no-op. */
  url: string;
  /** Provider-side identifier (issue number, ticket key, etc.). */
  externalId: string;
}

export interface TicketProvider {
  readonly name: string;
  isConfigured(): boolean;
  createTicket(req: CreateTicketRequest): Promise<CreateTicketResult>;
}

class NoopTicketProvider implements TicketProvider {
  readonly name = 'noop';
  isConfigured(): boolean { return false; }
  async createTicket(_req: CreateTicketRequest): Promise<CreateTicketResult> {
    return { provider: 'noop', url: '', externalId: '' };
  }
}

let _activeProvider: TicketProvider = new NoopTicketProvider();

export function setTicketProvider(provider: TicketProvider): void {
  _activeProvider = provider;
}

export function getTicketProvider(): TicketProvider {
  return _activeProvider;
}

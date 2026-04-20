import type { SessionPhase, SessionState, ServerEvent, ModeKey } from '@tetherline/shared';

export interface UtterResponse {
  ok: boolean;
  elapsedMs: number;
  newEvents: ServerEvent[];
  state: SessionState | null;
}

export class DevClient {
  constructor(private baseUrl: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/dev${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new DevApiError(res.status, text, `${method} ${path} → ${res.status}`);
    }
    if (res.headers.get('content-type')?.includes('application/json')) {
      return res.json() as Promise<T>;
    }
    return (await res.text()) as unknown as T;
  }

  async ping(): Promise<{ ok: boolean; ts: string }> {
    return this.req('GET', '/ping');
  }

  async startSession(params: {
    repoPath: string;
    entryMode?: 'full_walkthrough' | 'updates' | 'onboarding' | 'explore';
    sinceDays?: number;
  }): Promise<{ devSessionId: string; state: SessionState }> {
    return this.req('POST', '/session/start', params);
  }

  async resetSession(devSessionId: string): Promise<void> {
    await this.req('POST', '/session/reset', { devSessionId });
  }

  async getSession(id: string): Promise<{
    devSessionId: string;
    backendSessionId: string | null;
    state: SessionState;
    eventCount: number;
  }> {
    return this.req('GET', `/session/${id}`);
  }

  async waitForPhase(devSessionId: string, phase: SessionPhase, timeoutMs = 30_000): Promise<SessionState> {
    const { state } = await this.req<{ state: SessionState }>('POST', '/session/wait', { devSessionId, phase, timeoutMs });
    return state;
  }

  async waitForAnyPhase(devSessionId: string, phases: SessionPhase[], timeoutMs = 30_000): Promise<SessionState> {
    // Poll-based wait across multiple phases
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await this.getSession(devSessionId);
      if (phases.includes(session.state.phase)) return session.state;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for phases ${phases.join('|')}`);
  }

  async utter(devSessionId: string, text: string): Promise<UtterResponse> {
    return this.req('POST', '/utter', { devSessionId, text });
  }

  async command(
    devSessionId: string,
    type: 'next' | 'previous' | 'skip' | 'pause' | 'resume' | 'dive_deeper',
  ): Promise<UtterResponse> {
    return this.req('POST', '/command', { devSessionId, type });
  }

  async toggleMode(devSessionId: string, key: ModeKey, enabled: boolean): Promise<void> {
    await this.req('POST', '/mode', { devSessionId, key, enabled });
  }

  async exportFormat(devSessionId: string, format: 'slides' | 'markdown'): Promise<UtterResponse> {
    return this.req('POST', '/export', { devSessionId, format });
  }

  async events(devSessionId: string, since = 0): Promise<{ total: number; events: ServerEvent[] }> {
    return this.req('GET', `/session/${devSessionId}/events?since=${since}`);
  }

  async trace(opts: { sessionId?: string; since?: string; limit?: number } = {}): Promise<{ events: Array<Record<string, unknown>> }> {
    const params = new URLSearchParams();
    if (opts.sessionId) params.set('sessionId', opts.sessionId);
    if (opts.since) params.set('since', opts.since);
    if (opts.limit) params.set('limit', String(opts.limit));
    return this.req('GET', `/trace?${params}`);
  }

  async navigator(devSessionId: string): Promise<{
    depth: number;
    breadcrumb: string;
    frames: Array<{ briefingId: string; layer: string; title: string; reason: string; enteredAt: string }>;
  }> {
    return this.req('GET', `/navigator?devSessionId=${encodeURIComponent(devSessionId)}`);
  }

  async briefing(repoPath: string, id: string) {
    const p = new URLSearchParams({ repoPath, id });
    return this.req<{ briefing: any }>('GET', `/briefing?${p}`);
  }

  async briefings(repoPath: string, layer?: string) {
    const p = new URLSearchParams({ repoPath });
    if (layer) p.set('layer', layer);
    return this.req<{ briefings: any[] }>('GET', `/briefings?${p}`);
  }

  async comprehension(repoPath: string) {
    const p = new URLSearchParams({ repoPath });
    return this.req<{ repoPath: string; items: any[]; totals: Record<string, number> }>('GET', `/comprehension?${p}`);
  }

  async comprehensionMulti(repoPaths: string[]) {
    const p = new URLSearchParams({ repoPaths: repoPaths.join(',') });
    return this.req<{ maps: any[] }>('GET', `/comprehension/multi?${p}`);
  }
}

export class DevApiError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(`${message}: ${body}`);
  }
}

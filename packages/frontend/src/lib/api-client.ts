import { API_PREFIX } from '@tetherline/shared';

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  health: () => fetchApi<{ status: string; version: string; hasAnthropicKey: boolean; hasOpenaiKey: boolean }>('/health'),

  createSession: (repoPath: string, sinceDays?: number) =>
    fetchApi<{ sessionId: string; status: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ repoPath, sinceDays }),
    }),

  listSessions: () =>
    fetchApi<{ sessions: any[] }>('/sessions'),

  getSession: (id: string) =>
    fetchApi<{ session: any }>(`/sessions/${id}`),

  getSettings: () =>
    fetchApi<{ settings: any }>('/settings'),

  updateSettings: (updates: Record<string, any>) =>
    fetchApi<{ settings: any }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  exportSlides: (sessionId: string) =>
    fetchApi<{ downloadUrl: string }>(`/export/${sessionId}/slides`, { method: 'POST' }),

  exportMarkdown: (sessionId: string) =>
    fetchApi<{ downloadUrl: string }>(`/export/${sessionId}/markdown`, { method: 'POST' }),

  listRepos: () => fetchApi<{ repos: any[] }>('/repos'),

  addRepo: (repoPath: string) =>
    fetchApi<{ repo: any; commitCount?: number; contributorCount?: number; alreadyExists?: boolean }>('/repos', {
      method: 'POST',
      body: JSON.stringify({ path: repoPath }),
    }),

  getRepo: (id: string) =>
    fetchApi<{ repo: any; newCommits: number; contributors: string[]; recentSessions: any[] }>(`/repos/${id}`),

  removeRepo: (id: string) =>
    fetchApi<{ ok: boolean }>(`/repos/${id}`, { method: 'DELETE' }),

  generateOnboarding: (repoPath: string) =>
    fetchApi<{ program: any; alreadyExists?: boolean }>('/onboarding/generate', {
      method: 'POST',
      body: JSON.stringify({ repoPath }),
    }),
  getOnboardingProgram: (id: string) =>
    fetchApi<{ program: any; progress: any }>(`/onboarding/programs/${id}`),
  startOnboarding: (id: string) =>
    fetchApi<{ progress: any }>(`/onboarding/programs/${id}/start`, { method: 'POST' }),
  completeOnboardingDay: (id: string, dayNumber: number) =>
    fetchApi<{ progress: any }>(`/onboarding/programs/${id}/complete-day`, {
      method: 'POST',
      body: JSON.stringify({ dayNumber }),
    }),

  digestLatest: () =>
    fetchApi<{ digest: any; deliveryStatus?: string }>('/digest/latest'),

  digestGenerate: () =>
    fetchApi<{ digest: any; markdown: string; html: string }>('/digest/generate', { method: 'POST' }),

  digestSend: () =>
    fetchApi<{ ok: boolean }>('/digest/send', { method: 'POST' }),

  digestHistory: () =>
    fetchApi<{ digests: any[] }>('/digest/history'),
};

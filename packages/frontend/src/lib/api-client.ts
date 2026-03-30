import { API_PREFIX } from '@interactive-reviewer/shared';

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  health: () => fetchApi<{ status: string; version: string }>('/health'),

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
};

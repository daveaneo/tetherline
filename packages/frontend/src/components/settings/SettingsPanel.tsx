import { useState } from 'react';
import { useSettingsStore } from '../../state/settings-store.js';
import { api } from '../../lib/api-client.js';
import type { DigestConfig } from '@interactive-reviewer/shared';

export function SettingsPanel() {
  const { settingsOpen, setSettingsOpen, settings, setSettings } = useSettingsStore();
  const [digestSending, setDigestSending] = useState(false);
  const [digestResult, setDigestResult] = useState<string | null>(null);

  const digestConfig: DigestConfig = settings.digest ?? {
    enabled: false,
    schedule: '0 8 * * 1',
    delivery: 'app',
  };

  const updateDigest = (updates: Partial<DigestConfig>) => {
    setSettings({ digest: { ...digestConfig, ...updates } });
  };

  const sendTestDigest = async () => {
    setDigestSending(true);
    setDigestResult(null);
    try {
      await api.digestGenerate();
      setDigestResult('Digest generated successfully!');
    } catch (err: any) {
      setDigestResult(`Failed: ${err.message}`);
    } finally {
      setDigestSending(false);
    }
  };

  if (!settingsOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/50" onClick={() => setSettingsOpen(false)} />
      <div className="absolute right-0 top-0 bottom-0 w-96 bg-[var(--color-surface)] border-l border-[var(--color-border)] p-6 overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Settings</h2>
          <button onClick={() => setSettingsOpen(false)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            ✕
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-2">Anthropic API Key</label>
            <input
              type="password"
              value={settings.anthropicApiKey ?? ''}
              onChange={(e) => setSettings({ anthropicApiKey: e.target.value })}
              placeholder="sk-ant-..."
              className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">OpenAI API Key</label>
            <input
              type="password"
              value={settings.openaiApiKey ?? ''}
              onChange={(e) => setSettings({ openaiApiKey: e.target.value })}
              placeholder="sk-..."
              className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Voice</label>
            <select
              value={settings.ttsProvider}
              onChange={(e) => setSettings({ ttsProvider: e.target.value as any })}
              className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
            >
              <option value="openai">OpenAI (Premium)</option>
              <option value="browser">Browser (Free)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Review Period (days)</label>
            <input
              type="number"
              value={settings.sinceDays}
              onChange={(e) => setSettings({ sinceDays: parseInt(e.target.value, 10) })}
              min={1}
              max={30}
              className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
            />
          </div>

          <hr className="border-[var(--color-border)]" />

          <div>
            <h3 className="text-lg font-semibold mb-4">Weekly Digest</h3>

            <div className="flex items-center justify-between mb-4">
              <label className="text-sm font-medium">Enable weekly digest</label>
              <button
                onClick={() => updateDigest({ enabled: !digestConfig.enabled })}
                className={`relative w-10 h-6 rounded-full transition-colors ${digestConfig.enabled ? 'bg-indigo-500' : 'bg-zinc-600'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${digestConfig.enabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {digestConfig.enabled && (
              <>
                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">Delivery</label>
                  <select
                    value={digestConfig.delivery}
                    onChange={(e) => updateDigest({ delivery: e.target.value as DigestConfig['delivery'] })}
                    className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                  >
                    <option value="app">In-app only</option>
                    <option value="slack">Slack</option>
                  </select>
                </div>

                {digestConfig.delivery === 'slack' && (
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-2">Slack Webhook URL</label>
                    <input
                      type="text"
                      value={digestConfig.slackWebhookUrl ?? ''}
                      onChange={(e) => updateDigest({ slackWebhookUrl: e.target.value })}
                      placeholder="https://hooks.slack.com/services/..."
                      className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
                    />
                  </div>
                )}

                <button
                  onClick={sendTestDigest}
                  disabled={digestSending}
                  className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
                >
                  {digestSending ? 'Generating...' : 'Send Test Digest'}
                </button>
                {digestResult && (
                  <p className="text-xs text-[var(--color-text-muted)] mt-2">{digestResult}</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

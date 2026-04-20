import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSettingsStore } from '../../state/settings-store.js';
import { api } from '../../lib/api-client.js';
import type { DigestConfig } from '@tetherline/shared';

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--ink-000)',
  border: '1px solid oklch(1 0 0 / 0.06)',
  borderRadius: 'var(--r-md)',
  fontSize: 13,
  color: 'var(--cream-800)',
  fontFamily: 'var(--mono)',
  outline: 'none',
};

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
      setDigestResult('Digest generated successfully.');
    } catch (err: any) {
      setDigestResult(`Failed: ${err.message}`);
    } finally {
      setDigestSending(false);
    }
  };

  return (
    <AnimatePresence>
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0"
            style={{ background: 'color-mix(in oklch, var(--ink-000) 70%, transparent)', backdropFilter: 'blur(8px)' }}
            onClick={() => setSettingsOpen(false)}
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 26, stiffness: 260 }}
            className="absolute right-0 top-0 bottom-0 overflow-y-auto"
            style={{
              width: 420,
              background: 'var(--ink-100)',
              borderLeft: '1px solid oklch(1 0 0 / 0.06)',
              padding: 28,
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <div className="flex items-center justify-between mb-6">
              <div>
                <div className="kicker">Configure</div>
                <h2 className="font-serif mt-1" style={{ fontSize: 28, fontWeight: 300, letterSpacing: '-0.015em' }}>Settings</h2>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                style={{ color: 'var(--cream-500)', fontSize: 18 }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="space-y-6">
              <div>
                <label className="kicker block mb-2">Anthropic API key</label>
                <input
                  type="password"
                  value={settings.anthropicApiKey ?? ''}
                  onChange={(e) => setSettings({ anthropicApiKey: e.target.value })}
                  placeholder="sk-ant-…"
                  style={fieldStyle}
                />
              </div>

              <div>
                <label className="kicker block mb-2">OpenAI API key</label>
                <input
                  type="password"
                  value={settings.openaiApiKey ?? ''}
                  onChange={(e) => setSettings({ openaiApiKey: e.target.value })}
                  placeholder="sk-…"
                  style={fieldStyle}
                />
              </div>

              <div>
                <label className="kicker block mb-2">Voice provider</label>
                <select
                  value={settings.ttsProvider}
                  onChange={(e) => setSettings({ ttsProvider: e.target.value as any })}
                  style={fieldStyle}
                >
                  <option value="openai">OpenAI (Premium)</option>
                  <option value="browser">Browser (Free)</option>
                </select>
              </div>

              <div>
                <label className="kicker block mb-2">Review period (days)</label>
                <input
                  type="number"
                  value={settings.sinceDays}
                  onChange={(e) => setSettings({ sinceDays: parseInt(e.target.value, 10) })}
                  min={1}
                  max={30}
                  style={fieldStyle}
                />
              </div>

              <div className="hairline" />

              <div>
                <div className="kicker mb-1">Recurring</div>
                <h3 className="font-serif" style={{ fontSize: 22, fontWeight: 300, letterSpacing: '-0.015em', color: 'var(--cream-900)' }}>
                  Weekly digest
                </h3>

                <button
                  type="button"
                  onClick={() => updateDigest({ enabled: !digestConfig.enabled })}
                  className="toggle mt-4"
                  role="switch"
                  aria-checked={digestConfig.enabled}
                >
                  <div className="toggle-label">
                    <div className="t">Enable weekly digest</div>
                    <div className="d">Generate a Markdown digest on a cron schedule.</div>
                  </div>
                  <div className={`sw ${digestConfig.enabled ? 'is-on' : ''}`} />
                </button>

                {digestConfig.enabled && (
                  <div className="mt-4 space-y-4">
                    <div>
                      <label className="kicker block mb-2">Delivery</label>
                      <select
                        value={digestConfig.delivery}
                        onChange={(e) => updateDigest({ delivery: e.target.value as DigestConfig['delivery'] })}
                        style={fieldStyle}
                      >
                        <option value="app">In-app only</option>
                        <option value="slack">Slack</option>
                      </select>
                    </div>

                    {digestConfig.delivery === 'slack' && (
                      <div>
                        <label className="kicker block mb-2">Slack webhook URL</label>
                        <input
                          type="text"
                          value={digestConfig.slackWebhookUrl ?? ''}
                          onChange={(e) => updateDigest({ slackWebhookUrl: e.target.value })}
                          placeholder="https://hooks.slack.com/services/…"
                          style={fieldStyle}
                        />
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={sendTestDigest}
                      disabled={digestSending}
                      className="btn btn-primary"
                      style={{ width: '100%', justifyContent: 'center' }}
                    >
                      {digestSending ? 'Generating…' : 'Send test digest'}
                    </button>
                    {digestResult && (
                      <p className="font-mono" style={{ fontSize: 11, color: 'var(--cream-500)', letterSpacing: '0.02em' }}>
                        {digestResult}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

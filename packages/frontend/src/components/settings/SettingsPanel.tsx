import { useSettingsStore } from '../../state/settings-store.js';

export function SettingsPanel() {
  const { settingsOpen, setSettingsOpen, settings, setSettings } = useSettingsStore();

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
        </div>
      </div>
    </div>
  );
}

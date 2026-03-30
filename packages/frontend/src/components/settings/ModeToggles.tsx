import { useSettingsStore } from '../../state/settings-store.js';
import { sendEvent } from '../../lib/ws-client.js';
import type { ModeKey } from '@interactive-reviewer/shared';

const MODES: { key: ModeKey; label: string; icon: string }[] = [
  { key: 'narration', label: 'Narration', icon: '🔊' },
  { key: 'activeLearning', label: 'Active Learning', icon: '🧠' },
  { key: 'advisory', label: 'Advisory', icon: '⚡' },
  { key: 'alerts', label: 'Alerts', icon: '🚨' },
];

export function ModeToggles() {
  const modes = useSettingsStore(s => s.modes);
  const toggleMode = useSettingsStore(s => s.toggleMode);

  return (
    <div className="flex items-center gap-2">
      {MODES.map(({ key, label, icon }) => (
        <button
          key={key}
          onClick={() => {
            toggleMode(key);
            sendEvent({ type: 'command:toggle_mode', payload: { mode: key, enabled: !modes[key] } });
          }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full transition-colors ${
            modes[key]
              ? 'bg-[var(--color-accent)] text-white'
              : 'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]'
          }`}
          title={label}
        >
          <span>{icon}</span>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

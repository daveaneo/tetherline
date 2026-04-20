import { useSettingsStore } from '../../state/settings-store.js';
import { sendEvent } from '../../lib/ws-client.js';
import type { ModeKey } from '@tetherline/shared';

const MODES: { key: ModeKey; label: string; glyph: string; hint: string }[] = [
  { key: 'narration',      label: 'Narration',       glyph: '◉', hint: 'AI voice on/off' },
  { key: 'activeLearning', label: 'Active learning', glyph: '◐', hint: 'Socratic prompts' },
  { key: 'advisory',       label: 'Advisory',        glyph: '◇', hint: 'Concerns & flags' },
  { key: 'alerts',         label: 'Alerts',          glyph: '△', hint: 'Security / breaking' },
];

export function ModeToggles() {
  const modes = useSettingsStore(s => s.modes);
  const toggleMode = useSettingsStore(s => s.toggleMode);

  return (
    <div className="chrome-tabs" role="group" aria-label="Session modes">
      {MODES.map(({ key, label, glyph, hint }) => (
        <button
          key={key}
          type="button"
          onClick={() => {
            toggleMode(key);
            sendEvent({ type: 'command:toggle_mode', payload: { mode: key, enabled: !modes[key] } });
          }}
          className={`chrome-tab ${modes[key] ? 'is-on' : ''}`}
          title={`${label} — ${hint}`}
          aria-pressed={modes[key]}
        >
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, opacity: 0.8 }}>{glyph}</span>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

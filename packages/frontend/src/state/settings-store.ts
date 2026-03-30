import { create } from 'zustand';
import type { Settings, SessionModes, ModeKey } from '@interactive-reviewer/shared';
import { DEFAULT_SETTINGS, DEFAULT_MODES } from '@interactive-reviewer/shared';

interface SettingsStore {
  settings: Settings;
  modes: SessionModes;
  settingsOpen: boolean;

  setSettings: (settings: Partial<Settings>) => void;
  toggleMode: (mode: ModeKey) => void;
  setSettingsOpen: (open: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  modes: { ...DEFAULT_MODES },
  settingsOpen: false,

  setSettings: (updates) => set(s => ({ settings: { ...s.settings, ...updates } })),
  toggleMode: (mode) => set(s => ({ modes: { ...s.modes, [mode]: !s.modes[mode] } })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));

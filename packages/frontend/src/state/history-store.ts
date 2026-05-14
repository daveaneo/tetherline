/**
 * Open/close state for the conversation HistoryRail. Mirrors the
 * pattern used by GapsPanel — separate store keeps cross-cutting
 * UI toggles out of session-store.
 */
import { create } from 'zustand';

interface HistoryStore {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

export const useHistoryStore = create<HistoryStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set(s => ({ open: !s.open })),
}));

/** Tiny isolated store so the QuickChips, the chrome toolbar toggle, and
 *  the GapsPanel itself can all share open/close state without coupling
 *  through the session store. */
import { create } from 'zustand';

interface GapsStore {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

export const useGapsStore = create<GapsStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set(s => ({ open: !s.open })),
}));

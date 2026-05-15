/**
 * Review-shelf store (B9). Separate zustand store — keeping it out of
 * session-store is the STRUCTURAL "off the conversation thread"
 * guarantee: appending an artifact is a synchronous O(1) state set
 * that touches neither the narration nor the audio pipeline, so a
 * shelf write can never block or preempt the voice loop.
 */
import { create } from 'zustand';
import type { ShelfArtifact, ShelfSection } from '@tetherline/shared';
import { SHELF_SECTIONS } from '@tetherline/shared';

type BySection = Record<ShelfSection, ShelfArtifact[]>;
type Counts = Record<ShelfSection, number>;

const emptyBySection = (): BySection =>
  Object.fromEntries(SHELF_SECTIONS.map(s => [s, []])) as unknown as BySection;
const zeroCounts = (): Counts =>
  Object.fromEntries(SHELF_SECTIONS.map(s => [s, 0])) as unknown as Counts;

interface ShelfStore {
  open: boolean;
  activeSection: ShelfSection;
  artifacts: BySection;
  /** Per-section unread badge counts. */
  unread: Counts;
  setOpen: (v: boolean) => void;
  setActiveSection: (s: ShelfSection) => void;
  /** Synchronous, O(1). The only mutation a producer calls. */
  append: (a: ShelfArtifact) => void;
  /** Clears the unread badge for a section (on view). */
  markRead: (s: ShelfSection) => void;
}

export const useShelfStore = create<ShelfStore>((set) => ({
  open: false,
  activeSection: 'notes',
  artifacts: emptyBySection(),
  unread: zeroCounts(),
  setOpen: (open) => set({ open }),
  setActiveSection: (activeSection) => set({ activeSection }),
  append: (a) =>
    set((st) => ({
      artifacts: { ...st.artifacts, [a.section]: [a, ...st.artifacts[a.section]] },
      unread: { ...st.unread, [a.section]: st.unread[a.section] + 1 },
    })),
  markRead: (s) => set((st) => ({ unread: { ...st.unread, [s]: 0 } })),
}));

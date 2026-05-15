/** deep_dive pocket state machine (B14) — the pure core.
 *
 * Encodes every UX rule jammed into docs/VISUAL-COMPANION-PLAN.md so
 * they're enforced + unit-testable, not just prose:
 *
 *  - Explicit trigger only. Rung 2 is NEVER entered implicitly.
 *  - Scoping handshake = exactly ONE question, then commit.
 *  - Cancel (button/voice) is valid at the question AND during the
 *    loading screen; cancelling mid-compose ABORTS (no wasted run).
 *  - ≤10 slides, clamped server-side regardless of the outline.
 *  - Pocket is atomic on the spine: an outer skip pops the WHOLE
 *    pocket, never steps its slides.
 *  - Resumable: a pocket persists its slide cursor.
 *  - Never-silent recursion: a nested dive requires the SAME
 *    handshake (handled by callers re-entering `trigger`); the
 *    machine itself never auto-advances into a sub-pocket.
 *
 * Pure reducer: (state, event) -> state. No I/O, no LLM. The LLM
 * outline/slide composition + the submerge/resurface visual + the
 * station-index shelf wiring are the integration layer built on top.
 */

export const MAX_SLIDES = 10;

export type PocketPhase =
  | 'idle'
  | 'awaiting-scope' // handshake question asked, waiting for the focus answer
  | 'composing' // outline accepted, slides composing (loading screen)
  | 'active' // presenting; cursor on a slide
  | 'done' // exited normally
  | 'cancelled'; // cancelled at question OR mid-compose (aborted)

export interface PocketState {
  phase: PocketPhase;
  topic?: string;
  focus?: string;
  /** 0-based cursor; meaningful only in 'active'. */
  slide: number;
  /** total slides after clamping; 0 until composed. */
  total: number;
}

export type PocketEvent =
  | { t: 'trigger'; topic: string } // button / "deep dive"
  | { t: 'scope'; focus: string } // answer to the one handshake question
  | { t: 'composed'; slides: number } // outline → N slides ready
  | { t: 'next' }
  | { t: 'prev' }
  | { t: 'exit' } // leave the pocket (resurface)
  | { t: 'skip' } // OUTER spine skip — atomic
  | { t: 'cancel' }; // button/voice; valid at question & loading

export function initialPocket(): PocketState {
  return { phase: 'idle', slide: 0, total: 0 };
}

const clampSlides = (n: number) => Math.max(1, Math.min(MAX_SLIDES, Math.floor(n)));

export function pocketReducer(state: PocketState, ev: PocketEvent): PocketState {
  switch (ev.t) {
    case 'trigger':
      // Explicit entry only. Re-triggering from anywhere starts a
      // fresh handshake (a nested/sibling dive is also an explicit
      // trigger — never silent).
      return { phase: 'awaiting-scope', topic: ev.topic, slide: 0, total: 0 };

    case 'scope':
      // The one question was answered → commit to composing.
      if (state.phase !== 'awaiting-scope') return state;
      return { ...state, phase: 'composing', focus: ev.focus };

    case 'composed':
      // Outline ready. Clamp to the budget no matter what the LLM
      // returned. Ignore if we already cancelled mid-compose.
      if (state.phase !== 'composing') return state;
      return { ...state, phase: 'active', slide: 0, total: clampSlides(ev.slides) };

    case 'next':
      if (state.phase !== 'active') return state;
      // At the last slide, advancing exits the pocket (resurface).
      return state.slide >= state.total - 1
        ? { ...state, phase: 'done' }
        : { ...state, slide: state.slide + 1 };

    case 'prev':
      if (state.phase !== 'active') return state;
      return { ...state, slide: Math.max(0, state.slide - 1) };

    case 'exit':
      if (state.phase !== 'active') return state;
      return { ...state, phase: 'done' };

    case 'skip':
      // Outer spine skip is ATOMIC: from anywhere in the pocket it
      // pops the WHOLE pocket. It must NEVER step an inner slide.
      if (state.phase === 'idle' || state.phase === 'done' || state.phase === 'cancelled') {
        return state;
      }
      return { ...state, phase: 'done' };

    case 'cancel':
      // Valid at the question AND during loading (aborts the
      // in-flight compose). A no-op once active/done.
      if (state.phase === 'awaiting-scope' || state.phase === 'composing') {
        return { ...state, phase: 'cancelled' };
      }
      return state;
  }
}

/** True while the loading screen should show (compose in flight). */
export function isLoading(s: PocketState): boolean {
  return s.phase === 'composing';
}

/** True when the user is inside the pocket presentation. */
export function isPresenting(s: PocketState): boolean {
  return s.phase === 'active';
}

/** "1/8" label for the pocket cursor; '' when not presenting. */
export function slideLabel(s: PocketState): string {
  return s.phase === 'active' ? `${s.slide + 1}/${s.total}` : '';
}

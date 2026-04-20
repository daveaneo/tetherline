import type { Briefing, BriefingLayer } from '@tetherline/shared';

export interface NavigationFrame {
  briefingId: string;
  layer: BriefingLayer;
  title: string;
  enteredAt: string; // ISO
  /** If the user interrupted mid-speech on this briefing, track rough position
   *  so resume can pick up with a "as I was saying…" prefix. */
  resumeCursor?: {
    sinceEnterMs: number;
    fromEvent: 'utterance' | 'push' | 'pop';
  };
  reason: 'user_asked' | 'dive_deeper' | 'tour_next' | 'resume_pop' | 'session_start';
}

/** Simple stack that models the user's conversational drill-down. Top of the
 *  stack is the current briefing. Operations: push, pop, popTo, peek, reset.
 *
 *  Kept free of side effects so tests can exercise the state machine directly
 *  without spinning up a SessionManager. Event emission happens in the caller. */
export class Navigator {
  private stack: NavigationFrame[] = [];
  /** Opt-in soft cap — 6+ pushes in a row triggers a gentle hint. */
  readonly softDepthCap = 6;

  get depth(): number { return this.stack.length; }

  peek(): NavigationFrame | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  /** Push a new frame onto the stack. */
  push(frame: Omit<NavigationFrame, 'enteredAt'>): NavigationFrame {
    const full: NavigationFrame = { ...frame, enteredAt: new Date().toISOString() };
    this.stack.push(full);
    return full;
  }

  /** Pop the top frame and return it (may be undefined if stack is empty). */
  pop(): NavigationFrame | null {
    return this.stack.pop() ?? null;
  }

  /** Pop until the top frame matches the predicate (frame kept). Returns the
   *  frames removed, in reverse order (most recent first). */
  popTo(predicate: (f: NavigationFrame) => boolean): NavigationFrame[] {
    const removed: NavigationFrame[] = [];
    while (this.stack.length > 0 && !predicate(this.stack[this.stack.length - 1])) {
      removed.push(this.stack.pop()!);
    }
    return removed;
  }

  /** Pop back to the project-layer root. */
  popToProject(): NavigationFrame[] {
    return this.popTo(f => f.layer === 'project');
  }

  /** Replace the entire stack — used on session reset / start. */
  reset(initial?: Omit<NavigationFrame, 'enteredAt'>): void {
    this.stack = [];
    if (initial) this.push(initial);
  }

  /** Read-only snapshot of the full stack, bottom-first. */
  snapshot(): NavigationFrame[] {
    return [...this.stack];
  }

  /** Update the resume cursor on the current frame. */
  markResumeCursor(cursor: NonNullable<NavigationFrame['resumeCursor']>): void {
    const top = this.peek();
    if (top) top.resumeCursor = cursor;
  }

  /** Human-readable breadcrumb, walked root-to-leaf. */
  breadcrumb(): string {
    if (this.stack.length === 0) return 'Nowhere yet — waiting for you to start.';
    const titles = this.stack.map(f => f.title);
    if (titles.length === 1) return `We're at ${titles[0]}.`;
    const last = titles[titles.length - 1];
    const rest = titles.slice(0, -1).reverse().join(', within ');
    return `We're in ${last}, within ${rest}.`;
  }

  /** Given an intended briefing id, can we push it here? Enforces soft cap. */
  checkPush(briefingId: string): { allowed: boolean; hint?: string } {
    if (this.stack.length >= this.softDepthCap) {
      return {
        allowed: true,
        hint: `You're ${this.stack.length} levels deep — say "back to the overview" anytime to reset.`,
      };
    }
    if (this.stack.find(f => f.briefingId === briefingId)) {
      return { allowed: false, hint: `You're already in ${briefingId} — no need to push again.` };
    }
    return { allowed: true };
  }
}

/** Frame factory — common pattern. */
export function frameFromBriefing(
  briefing: Briefing,
  reason: NavigationFrame['reason'],
): Omit<NavigationFrame, 'enteredAt'> {
  return {
    briefingId: briefing.id,
    layer: briefing.layer,
    title: briefing.title,
    reason,
  };
}

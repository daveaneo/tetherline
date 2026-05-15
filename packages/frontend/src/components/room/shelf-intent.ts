/** Shelf access + quiet-notification logic (B9), pure & testable.
 *
 * The shelf is a click surface in a voice-first product, so it MUST
 * have a spoken door. And anything that "reports back" must NOT barge
 * in — the defined quiet notification is: a silent badge increment
 * PLUS at most ONE short spoken line, deferred and COALESCED.
 */
import type { ShelfSection } from '@tetherline/shared';

/** True when the user is asking to reach the shelf by voice. */
export function isShelfDoorRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  return /\b(what'?s on (my|the) shelf|read me my (notes|shelf)|my (notebook|notes|tasks|deep dives?)|any (tasks?|deep dives?) (done|ready|finished)|show me (my )?(shelf|notebook))\b/.test(
    t,
  );
}

export interface PendingNotice {
  section: ShelfSection;
  /** how many artifacts of this section are newly pending */
  count: number;
}

/** Collapse all pending notices into AT MOST ONE spoken line. Returns
 *  null when there is nothing to say (silent — badge only). Never
 *  stacks; never lists more than the top few sections. */
export function coalesceQuietNotice(pending: PendingNotice[]): string | null {
  const real = pending.filter(p => p.count > 0);
  const total = real.reduce((s, p) => s + p.count, 0);
  if (total === 0) return null;

  const label = (s: ShelfSection, n: number) =>
    `${n} ${SINGULAR[s]}${n === 1 ? '' : 's'}`;

  if (real.length === 1) {
    const { section, count } = real[0];
    // Singular reads better without the "1" ("Task ready" not
    // "1 task ready"); plural keeps the count.
    const phrase = count === 1 ? singular(section) : label(section, count);
    return `${cap(phrase)} ready on your shelf.`;
  }
  const parts = real
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(p => label(p.section, p.count));
  const head = parts.slice(0, -1).join(', ');
  return `${total} new items on your shelf: ${head} and ${parts[parts.length - 1]}.`;
}

const SINGULAR: Record<ShelfSection, string> = {
  notes: 'note',
  'deep-dives': 'deep dive',
  tasks: 'task',
  issues: 'tracked issue',
  comprehension: 'comprehension log',
};

function singular(s: ShelfSection): string {
  return SINGULAR[s];
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

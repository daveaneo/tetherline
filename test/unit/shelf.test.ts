import { describe, it, expect, beforeEach } from 'vitest';
import {
  isShelfDoorRequest,
  coalesceQuietNotice,
} from '../../packages/frontend/src/components/room/shelf-intent.js';
import { useShelfStore } from '../../packages/frontend/src/state/shelf-store.js';
import type { ShelfArtifact } from '../../packages/shared/src/types/shelf.js';

describe('shelf spoken door', () => {
  it('recognizes voice requests to reach the shelf', () => {
    for (const t of [
      "what's on my shelf",
      'read me my notes',
      'any tasks done',
      'show me my notebook',
      'my deep dives',
    ]) {
      expect(isShelfDoorRequest(t)).toBe(true);
    }
  });
  it('does not fire on unrelated speech', () => {
    expect(isShelfDoorRequest('explain the auth module')).toBe(false);
    expect(isShelfDoorRequest('what changed this week')).toBe(false);
    expect(isShelfDoorRequest(null)).toBe(false);
  });
});

describe('quiet notification coalescing (never stacks)', () => {
  it('is silent when nothing is pending (badge-only)', () => {
    expect(coalesceQuietNotice([])).toBeNull();
    expect(coalesceQuietNotice([{ section: 'tasks', count: 0 }])).toBeNull();
  });
  it('one section → one short line', () => {
    expect(coalesceQuietNotice([{ section: 'tasks', count: 1 }])).toBe(
      'Task ready on your shelf.',
    );
    expect(coalesceQuietNotice([{ section: 'notes', count: 3 }])).toBe(
      '3 notes ready on your shelf.',
    );
  });
  it('many sections collapse to ONE line, never N notifications', () => {
    const line = coalesceQuietNotice([
      { section: 'tasks', count: 2 },
      { section: 'notes', count: 1 },
      { section: 'comprehension', count: 1 },
    ]);
    expect(line).toBe('4 new items on your shelf: 2 tasks, 1 note and 1 comprehension log.');
    expect(line!.split('shelf').length).toBe(2); // single sentence
  });
});

describe('shelf store — off-thread structural guarantee', () => {
  beforeEach(() => {
    useShelfStore.setState({
      artifacts: { notes: [], 'deep-dives': [], tasks: [], issues: [], comprehension: [] },
      unread: { notes: 0, 'deep-dives': 0, tasks: 0, issues: 0, comprehension: 0 },
    });
  });
  const art = (id: string): ShelfArtifact => ({
    id,
    section: 'notes',
    summary: `note ${id}`,
    createdAt: '2026-05-15T00:00:00Z',
  });

  it('append is SYNCHRONOUS (not a promise) — cannot block narration', () => {
    const r = useShelfStore.getState().append(art('a'));
    expect(r).toBeUndefined(); // returns void synchronously, never awaited
    expect(useShelfStore.getState().artifacts.notes).toHaveLength(1);
  });

  it('append increments unread; markRead clears only that section', () => {
    const s = useShelfStore.getState();
    s.append(art('a'));
    s.append(art('b'));
    expect(useShelfStore.getState().unread.notes).toBe(2);
    useShelfStore.getState().markRead('notes');
    expect(useShelfStore.getState().unread.notes).toBe(0);
    expect(useShelfStore.getState().unread.tasks).toBe(0);
  });

  it('newest artifact is first (recency order)', () => {
    const s = useShelfStore.getState();
    s.append(art('old'));
    s.append(art('new'));
    expect(useShelfStore.getState().artifacts.notes.map(a => a.id)).toEqual(['new', 'old']);
  });
});

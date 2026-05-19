/** The non-blocking review shelf (B9) — one surface, typed sections.
 *  Mirrors the HistoryRail chrome pattern (fixed right drawer,
 *  ember/espresso skin). Read-only register: select a row to act;
 *  no edit/triage UI (the product boundary). Producers (annotate,
 *  deep_dive, task, track_issue, grill) append via the shelf store;
 *  this only displays. */
import { useShelfStore } from '../../state/shelf-store.js';
import { SHELF_SECTIONS, type ShelfSection } from '@tetherline/shared';

const SECTION_LABEL: Record<ShelfSection, string> = {
  notes: 'Notebook',
  'deep-dives': 'Deep dives',
  tasks: 'Tasks',
  issues: 'Issues',
  comprehension: 'Comprehension',
};

/** Scannable task-state colour. blocked = needs you (concern), done =
 *  finished (okay), branch/running = in flight (neutral accent).
 *  Unknown states keep the muted default. */
function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (s.startsWith('blocked')) return 'var(--sig-concern)';
  if (s.startsWith('done')) return 'var(--sig-okay)';
  if (s.startsWith('branch:') || s.startsWith('running')) return 'var(--color-accent)';
  return 'var(--cream-500)';
}

export function ReviewShelf() {
  const open = useShelfStore(s => s.open);
  const setOpen = useShelfStore(s => s.setOpen);
  const active = useShelfStore(s => s.activeSection);
  const setActive = useShelfStore(s => s.setActiveSection);
  const artifacts = useShelfStore(s => s.artifacts);
  const unread = useShelfStore(s => s.unread);
  const markRead = useShelfStore(s => s.markRead);

  if (!open) return null;
  const rows = artifacts[active];

  return (
    <aside
      role="complementary"
      aria-label="Review shelf"
      data-testid="review-shelf"
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 380,
        background: 'color-mix(in oklch, var(--ink-100) 92%, transparent)',
        borderLeft: '1px solid oklch(1 0 0 / 0.08)',
        backdropFilter: 'blur(8px)', zIndex: 41,
        display: 'flex', flexDirection: 'column',
        boxShadow: '-4px 0 24px oklch(0 0 0 / 0.4)',
      }}
    >
      <header style={{ padding: '14px 18px', borderBottom: '1px solid oklch(1 0 0 / 0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="font-mono" style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
          Review shelf
        </span>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close shelf"
          className="text-xs" style={{ color: 'var(--cream-500)', cursor: 'pointer', background: 'transparent', border: 'none', padding: '4px 8px' }}>
          ✕
        </button>
      </header>

      <div role="tablist" style={{ display: 'flex', gap: 4, padding: '10px 12px', flexWrap: 'wrap', borderBottom: '1px solid oklch(1 0 0 / 0.05)' }}>
        {SHELF_SECTIONS.map(s => (
          <button
            key={s}
            role="tab"
            aria-selected={s === active}
            onClick={() => { setActive(s); markRead(s); }}
            className="font-mono"
            style={{
              fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
              padding: '5px 9px', borderRadius: 6, cursor: 'pointer', border: 'none',
              background: s === active ? 'oklch(0.74 0.12 65 / 0.2)' : 'oklch(1 0 0 / 0.03)',
              color: s === active ? 'var(--amber-400, oklch(0.74 0.12 65))' : 'var(--cream-500)',
            }}
          >
            {SECTION_LABEL[s]}
            {unread[s] > 0 && (
              <span style={{ marginLeft: 6, color: 'var(--amber-400, oklch(0.74 0.12 65))' }}>•{unread[s]}</span>
            )}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.length === 0 ? (
          <div className="font-mono" style={{ fontSize: 12, color: 'var(--cream-500)', opacity: 0.6, textAlign: 'center', paddingTop: 28 }}>
            Nothing here yet.
          </div>
        ) : (
          rows.map(a => (
            <div key={a.id} style={{ background: 'oklch(1 0 0 / 0.03)', border: '1px solid oklch(1 0 0 / 0.06)', borderRadius: 8, padding: '10px 12px' }}>
              <div className="font-serif" style={{ fontSize: 13, color: 'var(--cream-100)', lineHeight: 1.45 }}>
                {a.summary}
                {a.state && (
                  <span className="font-mono" style={{ marginLeft: 8, fontSize: 10, color: stateColor(a.state) }}>· {a.state}</span>
                )}
              </div>
              {a.detail && (
                <div className="font-serif" style={{ fontSize: 12, color: 'var(--cream-300)', opacity: 0.8, marginTop: 5 }}>{a.detail}</div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

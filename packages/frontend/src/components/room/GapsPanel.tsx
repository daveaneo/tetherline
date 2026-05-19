/**
 * "What don't I know?" panel — turns the comprehension map from decoration
 * into a decision aid. Lists what you haven't engaged with yet, ranked by
 * impact (areas of recent change first, then modules you've only heard
 * about). Each item is tappable to dive in.
 */
import { useMemo } from 'react';
import { useSessionStore } from '../../state/session-store.js';
import { useAudioStore } from '../../state/audio-store.js';
import { useGapsStore } from '../../state/gaps-store.js';
import { sendEvent } from '../../lib/ws-client.js';
import { bestTestPct, hasTest } from '@tetherline/shared';
import { levelColor } from './level-color.js';

interface Gap {
  id: string;
  label: string;
  reason: string;
  utterance: string;
  // v3 readout for the tag (replaces the single level word).
  seen?: boolean;
  testedPct?: number | null;
}

export function GapsPanel() {
  const open = useGapsStore(s => s.open);
  const setOpen = useGapsStore(s => s.setOpen);

  const areas = useSessionStore(s => s.areas);
  const areaIndex = useSessionStore(s => s.state.areaIndex);
  const comprehensionMap = useSessionStore(s => s.comprehensionMap);
  const recallQuestions = useSessionStore(s => s.recallQuestions);
  const recallItems = useSessionStore(s => s.recallItems);

  const gaps = useMemo<Gap[]>(() => {
    const out: Gap[] = [];

    // 1. Areas of recent change you haven't reached yet — high impact by definition.
    const ai = areaIndex ?? -1;
    for (let i = 0; i < areas.length; i++) {
      if (i <= ai) continue; // already visited or current
      const a = areas[i];
      out.push({
        id: `area:${a.id}`,
        label: a.name,
        reason: a.description?.slice(0, 100) ?? 'Recent changes you haven\'t reviewed.',
        utterance: `Tell me about the ${a.name} area.`,
      });
    }

    // 2. v3 gaps: things you either haven't actually watched (`!seen`)
    //    or watched but never proved (`!hasTest`). Same Seen + Quiz/
    //    Grill model the diagram uses — no more divergent `level` word.
    for (const [id, item] of comprehensionMap) {
      const tested = hasTest(item);
      if (item.seen && tested) continue; // seen AND tested → not a gap
      // Skip the ones already covered by areas above
      if (out.some(o => o.label.toLowerCase() === item.label.toLowerCase())) continue;
      out.push({
        id,
        label: item.label,
        reason: !item.seen
          ? 'Not walked through yet — you haven\'t actually heard this.'
          : 'Heard but never tested — quiz or grill to prove it.',
        utterance: `Tell me about ${item.label}.`,
        seen: item.seen,
        testedPct: tested ? bestTestPct(item) : null,
      });
    }

    return out;
  }, [areas, areaIndex, comprehensionMap]);

  if (!open) return null;

  const onPick = (gap: Gap) => {
    useSessionStore.getState().addConversation('you', gap.utterance);
    useAudioStore.getState().setVoiceState('processing');
    sendEvent({ type: 'user:utterance', payload: { text: gap.utterance, timestamp: Date.now() } });
    setOpen(false);
  };

  return (
    <>
      {/* Click-outside scrim */}
      <div
        className="absolute inset-0 z-40"
        style={{ background: 'oklch(0 0 0 / 0.35)' }}
        onClick={() => setOpen(false)}
        data-testid="gaps-scrim"
      />
      <aside
        className="absolute top-0 right-0 bottom-0 z-50 flex flex-col"
        style={{
          width: 420,
          maxWidth: '90vw',
          background: 'var(--ink-050)',
          borderLeft: '1px solid oklch(1 0 0 / 0.06)',
          boxShadow: '-12px 0 40px oklch(0 0 0 / 0.3)',
        }}
        data-testid="gaps-panel"
        aria-label="Knowledge gaps"
      >
        <header
          className="flex items-baseline justify-between flex-none"
          style={{ padding: '20px 24px 12px', borderBottom: '1px solid oklch(1 0 0 / 0.05)' }}
        >
          <div>
            <div
              className="font-mono"
              style={{ fontSize: 9.5, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cream-500)' }}
            >
              Knowledge gaps
            </div>
            <div
              className="font-serif"
              style={{ fontSize: 22, fontStyle: 'italic', color: 'var(--amber-400)', marginTop: 2 }}
            >
              what don't I know?
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="btn btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12 }}
            aria-label="Close knowledge gaps"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto" style={{ padding: '12px 16px 24px' }}>
          {recallItems.length > 0 && (
            <section style={{ marginBottom: 16 }} data-testid="recall-items">
              <div
                className="font-mono"
                style={{
                  fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase',
                  color: 'var(--cream-500)', opacity: 0.8, padding: '4px 8px 8px',
                }}
              >
                Pick up where you left off
              </div>
              <ul className="flex flex-col gap-1.5" style={{ listStyle: 'none', padding: 0 }}>
                {recallItems.map(item => {
                  const utterance = `tell me about ${prettyRecallLabel(item)}`;
                  const driftHint = item.commitsSinceLastTouch > 0
                    ? `${item.commitsSinceLastTouch} commit${item.commitsSinceLastTouch === 1 ? '' : 's'} touched it since`
                    : 'nothing has changed since';
                  return (
                    <li key={item.itemId}>
                      <button
                        type="button"
                        onClick={() => onPick({ id: `recall-item:${item.itemId}`, label: item.label, reason: '', utterance })}
                        className="w-full text-left"
                        style={{
                          padding: '10px 12px',
                          borderRadius: 8,
                          border: '1px solid oklch(1 0 0 / 0.06)',
                          background: 'color-mix(in oklch, var(--amber-400) 10%, var(--ink-100) 70%)',
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span style={{ fontSize: 13, color: 'var(--cream-100)', fontWeight: 500 }}>
                            {item.label}
                          </span>
                          <span
                            className="font-mono flex-none"
                            style={{
                              fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase',
                              color: levelColor(item.level) ?? 'var(--cream-500)',
                            }}
                          >
                            {item.level}
                          </span>
                        </div>
                        <p
                          className="narration"
                          style={{ fontSize: 11.5, color: 'var(--cream-500)', marginTop: 4, fontStyle: 'italic' }}
                        >
                          {driftHint}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {recallQuestions.length > 0 && (
            <section style={{ marginBottom: 16 }}>
              <div
                className="font-mono"
                style={{
                  fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase',
                  color: 'var(--cream-500)', opacity: 0.8, padding: '4px 8px 8px',
                }}
              >
                Last time you asked
              </div>
              <ul className="flex flex-col gap-1.5" style={{ listStyle: 'none', padding: 0 }}>
                {recallQuestions.map((q, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => onPick({ id: `recall:${i}`, label: q, reason: '', utterance: q })}
                      className="w-full text-left"
                      style={{
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: '1px solid oklch(1 0 0 / 0.05)',
                        background: 'color-mix(in oklch, var(--amber-400) 8%, var(--ink-100) 70%)',
                        cursor: 'pointer',
                        fontSize: 13,
                        color: 'var(--cream-100)',
                        fontStyle: 'italic',
                      }}
                    >
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {gaps.length === 0 ? (
            <p
              className="narration"
              style={{ fontSize: 14, color: 'var(--cream-500)', padding: '24px 8px' }}
            >
              {recallQuestions.length > 0
                ? "Nothing new uncovered yet — pick up where you left off above."
                : "You're caught up — no obvious gaps in this session."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2" style={{ listStyle: 'none', padding: 0 }}>
              {gaps.map(gap => (
                <li key={gap.id}>
                  <button
                    type="button"
                    onClick={() => onPick(gap)}
                    className="w-full text-left"
                    style={{
                      padding: '12px 14px',
                      borderRadius: 10,
                      border: '1px solid oklch(1 0 0 / 0.06)',
                      background: 'color-mix(in oklch, var(--ink-100) 70%, transparent)',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span style={{ fontSize: 14, color: 'var(--cream-100)', fontWeight: 500 }}>
                        {gap.label}
                      </span>
                      <span
                        className="font-mono flex-none"
                        style={{
                          fontSize: 9,
                          letterSpacing: '0.16em',
                          textTransform: 'uppercase',
                          color: 'var(--cream-500)',
                        }}
                      >
                        Seen {gap.seen ? '✓' : '–'} · Q {gap.testedPct == null ? '—' : `${gap.testedPct}%`}
                      </span>
                    </div>
                    <p
                      className="narration"
                      style={{ fontSize: 12, color: 'var(--cream-500)', marginTop: 4 }}
                    >
                      {gap.reason}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function prettyRecallLabel(item: { itemId: string; label: string }): string {
  // Strip layer prefix from itemId for spoken-form addressing.
  if (item.itemId.startsWith('module/')) return item.itemId.slice('module/'.length);
  if (item.itemId.startsWith('file/'))   return item.itemId.slice('file/'.length);
  if (item.itemId.startsWith('code/'))   return item.itemId.slice('code/'.length).split(':')[0];
  return item.label || item.itemId;
}

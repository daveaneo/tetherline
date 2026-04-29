/**
 * HermesText — the single text surface for everything Hermes says.
 *
 * Replaces three previous surfaces:
 *   1. BriefingCard overlay (gone — the diagram + comprehension heatmap
 *      take that real estate now).
 *   2. NarrationBar's line-clamp-2 current-segment text (was eliding
 *      Hermes's actual words).
 *   3. LiveTranscript right-side panel (subsumed here).
 *
 * Two states:
 *   • Collapsed (default): one prose line of whatever Hermes is saying
 *     right now, no ellipsis truncation — wraps if long. Calm, low
 *     visual weight, leaves the diagram dominant.
 *   • Expanded: scrollable history of every turn (you + Hermes) +
 *     in-flight stream chunks at the bottom. Fixed-height panel that
 *     auto-scrolls to latest.
 *
 * Subscribes to streamChunks + currentStreamChunk + currentBriefing
 * (for non-streaming greetings) + conversationHistory (for scrollback).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../state/session-store.js';

export function HermesText() {
  const conversationHistory = useSessionStore(s => s.conversationHistory);
  const streamChunks = useSessionStore(s => s.streamChunks);
  const currentStreamChunk = useSessionStore(s => s.currentStreamChunk);
  const currentBriefing = useSessionStore(s => s.currentBriefing);
  const phase = useSessionStore(s => s.state.phase);

  const [expanded, setExpanded] = useState(false);

  // What's being said RIGHT NOW. Priority: in-flight stream chunk
  // (one being spoken) → next queued chunk → most recent briefing → most
  // recent AI conversation entry. Empty if none of those exist.
  const liveLine = useMemo(() => {
    if (currentStreamChunk?.text) return currentStreamChunk.text;
    if (streamChunks.length > 0) return streamChunks[0].text;
    if (currentBriefing?.text) return currentBriefing.text;
    const lastAi = [...conversationHistory].reverse().find(e => e.speaker === 'ai');
    return lastAi?.text ?? '';
  }, [currentStreamChunk, streamChunks, currentBriefing, conversationHistory]);

  // Auto-scroll the expanded log to the bottom on new content.
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!expanded || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [expanded, conversationHistory.length, currentStreamChunk?.text, streamChunks.length]);

  // Hide on the lobby — nothing to say yet.
  if (phase === 'IDLE') return null;
  if (!liveLine && conversationHistory.length === 0) return null;

  return (
    <div
      data-testid="hermes-text"
      data-expanded={expanded ? 'true' : 'false'}
      style={{
        background: 'color-mix(in oklch, var(--ink-050) 92%, transparent)',
        borderTop: '1px solid oklch(1 0 0 / 0.05)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {expanded ? (
        <div className="flex flex-col" style={{ maxHeight: '38vh' }}>
          <header className="flex items-center justify-between flex-none" style={{ padding: '10px 24px 8px' }}>
            <span
              className="font-mono"
              style={{
                fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase',
                color: 'var(--cream-500)', opacity: 0.8,
              }}
            >
              Conversation
            </span>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="btn btn-ghost"
              style={{ padding: '4px 10px', fontSize: 11 }}
              aria-label="Collapse conversation log"
              data-testid="hermes-text-collapse"
            >
              ▼ Collapse
            </button>
          </header>
          <div
            ref={logRef}
            className="flex-1 overflow-y-auto font-serif"
            style={{
              padding: '4px 24px 12px',
              fontSize: 14,
              lineHeight: 1.55,
              color: 'var(--cream-100)',
            }}
          >
            {conversationHistory.map((entry, i) => (
              <div key={`${entry.timestamp}-${i}`} style={{ marginBottom: 10 }}>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
                    color: entry.speaker === 'you' ? 'var(--sig-okay)' : 'var(--amber-400)',
                    marginRight: 8,
                  }}
                >
                  {entry.speaker === 'you' ? 'You' : 'Hermes'}
                </span>
                <span>{entry.text}</span>
              </div>
            ))}
            {streamChunks.length > 0 && (
              <div style={{ marginBottom: 10, opacity: 0.85 }}>
                <span
                  className="font-mono"
                  style={{
                    fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
                    color: 'var(--amber-400)', marginRight: 8,
                  }}
                >
                  Hermes
                </span>
                <span>{streamChunks.map(c => c.text).join(' ')}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className="flex items-start gap-3"
          style={{ padding: '10px 24px' }}
        >
          <span
            className="font-mono flex-none"
            style={{
              fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--amber-400)', marginTop: 4,
            }}
          >
            Hermes
          </span>
          <p
            className="font-serif flex-1"
            style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--cream-100)', margin: 0 }}
          >
            {liveLine}
          </p>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="btn btn-ghost flex-none"
            style={{ padding: '4px 10px', fontSize: 11, marginTop: 2 }}
            aria-label="Expand conversation log"
            data-testid="hermes-text-expand"
          >
            ▲ Log
          </button>
        </div>
      )}
    </div>
  );
}

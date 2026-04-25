/**
 * LiveTranscript — scrollback of the current and recent spoken lines.
 *
 * The narration bar already shows the *single* active segment; this panel
 * stacks the conversation so users who are skimming (or who missed a line)
 * can read instead of replay. Streamed answer chunks accumulate into one
 * line so the panel matches what's actually being said, not what the
 * backend chunked it into.
 */
import { useMemo } from 'react';
import { useSessionStore } from '../../state/session-store.js';

export function LiveTranscript() {
  const conversationHistory = useSessionStore(s => s.conversationHistory);
  const streamChunks = useSessionStore(s => s.streamChunks);
  const currentBriefing = useSessionStore(s => s.currentBriefing);
  const phase = useSessionStore(s => s.state.phase);

  const lines = useMemo(() => {
    const out: Array<{ speaker: 'you' | 'ai'; text: string; key: string }> = [];
    // Last 8 conversation entries.
    for (const entry of conversationHistory.slice(-8)) {
      out.push({ speaker: entry.speaker, text: entry.text, key: `${entry.timestamp}-${entry.speaker}` });
    }
    // In-flight stream chunks (not yet committed to history) tail the list.
    if (streamChunks.length > 0) {
      out.push({
        speaker: 'ai',
        text: streamChunks.map(c => c.text).join(' '),
        key: `stream-${streamChunks[0].streamId}`,
      });
    }
    return out;
  }, [conversationHistory, streamChunks]);

  // Hide on the lobby — nothing's been said yet.
  if (phase === 'IDLE') return null;
  if (lines.length === 0 && !currentBriefing) return null;

  return (
    <aside
      className="font-serif"
      data-testid="live-transcript"
      style={{
        position: 'absolute',
        right: 12,
        bottom: 100,
        width: 320,
        maxHeight: 240,
        overflowY: 'auto',
        padding: '12px 14px',
        borderRadius: 12,
        border: '1px solid oklch(1 0 0 / 0.05)',
        background: 'color-mix(in oklch, var(--ink-050) 88%, transparent)',
        backdropFilter: 'blur(6px)',
        boxShadow: '0 8px 32px oklch(0 0 0 / 0.25)',
        fontSize: 12,
        zIndex: 35,
      }}
    >
      <div
        className="font-mono"
        style={{
          fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase',
          color: 'var(--cream-500)', marginBottom: 6, opacity: 0.8,
        }}
      >
        Transcript
      </div>
      {lines.map(line => (
        <div key={line.key} style={{ marginBottom: 8, lineHeight: 1.45 }}>
          <span
            className="font-mono"
            style={{
              fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: line.speaker === 'you' ? 'var(--sig-okay)' : 'var(--amber-400)',
              marginRight: 6,
            }}
          >
            {line.speaker === 'you' ? 'You' : 'Hermes'}
          </span>
          <span style={{ color: 'var(--cream-200)' }}>{line.text}</span>
        </div>
      ))}
    </aside>
  );
}

/**
 * HistoryRail — collapsible side panel listing every Q/A turn in this
 * session. Per the design jam:
 *   • Toggleable via a chrome button (sibling of Gaps)
 *   • Each turn is a card that inline-expands to show the full text
 *   • No audio replay on click — archive view, instant-on
 *   • Headline zone (HermesText) stays the LIVE conversation surface;
 *     the rail is the persistent record. They never compete.
 */
import { useState } from 'react';
import { useSessionStore, type ConversationEntry } from '../../state/session-store.js';
import { useHistoryStore } from '../../state/history-store.js';

const PREVIEW_CHARS = 90;

export function HistoryRail() {
  const open = useHistoryStore(s => s.open);
  const setOpen = useHistoryStore(s => s.setOpen);
  const conversationHistory = useSessionStore(s => s.conversationHistory);

  if (!open) return null;

  // Group consecutive entries into Q/A pairs so each card represents
  // a turn, not a raw line. A 'you' followed by an 'ai' is one turn;
  // an isolated 'ai' (e.g. an unsolicited briefing) is its own card.
  const turns = groupTurns(conversationHistory);

  return (
    <aside
      role="complementary"
      aria-label="Conversation history"
      data-testid="history-rail"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        background: 'color-mix(in oklch, var(--ink-100) 92%, transparent)',
        borderLeft: '1px solid oklch(1 0 0 / 0.08)',
        backdropFilter: 'blur(8px)',
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-4px 0 24px oklch(0 0 0 / 0.4)',
      }}
    >
      <header
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid oklch(1 0 0 / 0.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          className="font-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--cream-500)',
          }}
        >
          Conversation · {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close history"
          className="text-xs"
          style={{
            color: 'var(--cream-500)',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            padding: '4px 8px',
          }}
        >
          ✕
        </button>
      </header>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {turns.length === 0 ? (
          <div
            className="font-mono"
            style={{
              fontSize: 12,
              color: 'var(--cream-500)',
              opacity: 0.65,
              textAlign: 'center',
              paddingTop: 32,
            }}
          >
            No turns yet. Ask Hermes something.
          </div>
        ) : (
          // Reverse so most recent is at the top — voice-first
          // conversation, scroll DOWN to go back in time.
          [...turns].reverse().map((turn, i) => (
            <TurnCard key={turns.length - 1 - i} turn={turn} />
          ))
        )}
      </div>
    </aside>
  );
}

interface Turn {
  question?: string;
  answer?: string;
  timestamp: number;
}

function groupTurns(entries: ConversationEntry[]): Turn[] {
  const out: Turn[] = [];
  let current: Turn | null = null;
  for (const entry of entries) {
    if (entry.speaker === 'you') {
      // Start a new turn for the question.
      if (current) out.push(current);
      current = { question: entry.text, timestamp: entry.timestamp };
    } else {
      // 'ai'
      if (current && !current.answer) {
        current.answer = entry.text;
      } else {
        // Unsolicited AI line (briefing, ack) → its own card.
        if (current) { out.push(current); current = null; }
        out.push({ answer: entry.text, timestamp: entry.timestamp });
      }
    }
  }
  if (current) out.push(current);
  return out;
}

function TurnCard({ turn }: { turn: Turn }) {
  const [expanded, setExpanded] = useState(false);
  const answerPreview = turn.answer && turn.answer.length > PREVIEW_CHARS
    ? turn.answer.slice(0, PREVIEW_CHARS) + '…'
    : turn.answer;
  const hasMore = turn.answer && turn.answer.length > PREVIEW_CHARS;

  return (
    <button
      type="button"
      onClick={() => hasMore && setExpanded(e => !e)}
      style={{
        textAlign: 'left',
        background: 'oklch(1 0 0 / 0.03)',
        border: '1px solid oklch(1 0 0 / 0.06)',
        borderRadius: 8,
        padding: '10px 12px',
        cursor: hasMore ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
      aria-expanded={expanded}
    >
      {turn.question && (
        <div
          className="font-serif"
          style={{
            fontSize: 13,
            color: 'var(--cream-100)',
            lineHeight: 1.45,
            letterSpacing: '-0.005em',
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 9,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--cream-500)',
              marginRight: 6,
              opacity: 0.7,
            }}
          >
            you
          </span>
          {turn.question}
        </div>
      )}
      {turn.answer && (
        <div
          className="font-serif"
          style={{
            fontSize: 13,
            color: 'var(--cream-300)',
            lineHeight: 1.45,
            letterSpacing: '-0.005em',
          }}
        >
          <span
            className="font-mono"
            style={{
              fontSize: 9,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--amber-400, oklch(0.74 0.12 65))',
              marginRight: 6,
              opacity: 0.85,
            }}
          >
            hermes
          </span>
          {expanded ? turn.answer : answerPreview}
          {hasMore && (
            <span
              className="font-mono"
              style={{
                marginLeft: 8,
                fontSize: 10,
                color: 'var(--cream-500)',
                opacity: 0.6,
              }}
            >
              {expanded ? '— click to collapse' : '— click to expand'}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

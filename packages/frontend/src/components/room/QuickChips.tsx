/**
 * Tap-to-ask chips above the narration bar. Each chip's label IS the utterance
 * sent to the backend — so the existing intent classifier / Q&A pipeline
 * resolves them without special handling. Lets users drive the session by
 * tap when speaking is awkward (open office, on a call, etc.).
 *
 * Chips are context-aware: the set adapts to the current phase. Always-on
 * chips ("What don't I know?", "What changed?") sit alongside phase-specific
 * ones so the user always has something useful to tap.
 */
import { useSessionStore } from '../../state/session-store.js';
import { useAudioStore } from '../../state/audio-store.js';
import { useGapsStore } from '../../state/gaps-store.js';
import { sendEvent } from '../../lib/ws-client.js';

interface Chip {
  label: string;
  /** Optional override — if the spoken-form differs from the visible label. */
  utterance?: string;
}

function chipsForPhase(phase: string, areaName: string | undefined): Chip[] {
  const universal: Chip[] = [
    { label: 'What changed?', utterance: 'What changed in this codebase recently?' },
    { label: "What don't I know?", utterance: "What don't I know yet?" },
  ];

  switch (phase) {
    case 'PROJECT_OVERVIEW':
    case 'OVERVIEW':
      return [
        { label: 'What is this project?', utterance: 'Tell me about this project.' },
        { label: 'Main parts?', utterance: 'What are the main parts of this codebase?' },
        ...universal,
      ];
    case 'ARCHITECTURE_OVERVIEW':
      return [
        { label: 'How does it fit together?', utterance: 'How do these modules fit together?' },
        { label: 'Most complex part?', utterance: 'Which module is the most complex?' },
        ...universal,
      ];
    case 'AREA_WALKTHROUGH':
    case 'COMPONENT_TOUR':
      return [
        { label: areaName ? `Why was ${areaName} changed?` : 'Why was this changed?', utterance: areaName ? `Why was ${areaName} changed?` : 'Why was this changed?' },
        { label: 'Go deeper', utterance: 'Tell me more about this.' },
        { label: 'Show concerns', utterance: 'Show me any concerns.' },
        { label: 'Skip', utterance: 'skip' },
      ];
    case 'ADVISORY':
      return [
        { label: 'Most critical?', utterance: 'Which concern is most critical?' },
        { label: 'How do I fix it?', utterance: 'How would you suggest fixing this?' },
        ...universal,
      ];
    case 'PROPOSAL':
      return [
        { label: 'Sounds good', utterance: 'sounds good' },
        { label: 'Skip the tour', utterance: "let's skip the tour" },
        { label: 'Just explore', utterance: 'just let me explore' },
      ];
    case 'WRAP_UP':
    case 'COMPLETED':
      return [
        { label: 'Export slides', utterance: 'export slides' },
        { label: 'Export markdown', utterance: 'export markdown' },
        { label: 'Back to lobby', utterance: 'exit' },
      ];
    default:
      return universal;
  }
}

export function QuickChips() {
  const phase = useSessionStore(s => s.state.phase);
  const areaIndex = useSessionStore(s => s.state.areaIndex);
  const areas = useSessionStore(s => s.areas);
  const paused = useSessionStore(s => s.state.paused);

  // Hide chips while paused — pause means "stop interacting" right now.
  // Hide on IDLE (lobby) and ANALYZING (no targets exist yet).
  if (paused || phase === 'IDLE' || phase === 'ANALYZING' || phase === 'ERROR') return null;

  const currentArea = areaIndex !== undefined ? areas[areaIndex]?.name : undefined;
  const chips = chipsForPhase(phase, currentArea);
  if (chips.length === 0) return null;

  const onChip = (chip: Chip) => {
    const text = chip.utterance ?? chip.label;
    // Special handling: "What don't I know?" opens the structured panel AND
    // sends the utterance so the AI gives a verbal interpretation alongside.
    if (chip.label === "What don't I know?") {
      useGapsStore.getState().setOpen(true);
    }
    useSessionStore.getState().addConversation('you', text);
    useAudioStore.getState().setVoiceState('processing');
    sendEvent({ type: 'user:utterance', payload: { text, timestamp: Date.now() } });
  };

  return (
    <div
      className="flex items-center gap-2 overflow-x-auto"
      style={{
        padding: '8px 24px 6px',
        background: 'color-mix(in oklch, var(--ink-050) 60%, transparent)',
        borderTop: '1px solid oklch(1 0 0 / 0.04)',
      }}
      data-testid="quick-chips"
    >
      <span
        className="font-mono flex-none"
        style={{
          fontSize: 9,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--cream-500)',
          opacity: 0.7,
          marginRight: 4,
        }}
      >
        Tap to ask
      </span>
      {chips.map((chip, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChip(chip)}
          className="btn btn-ghost flex-none"
          style={{
            padding: '6px 12px',
            fontSize: 12,
            borderRadius: 999,
            border: '1px solid oklch(1 0 0 / 0.08)',
            background: 'color-mix(in oklch, var(--ink-100) 50%, transparent)',
            whiteSpace: 'nowrap',
          }}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

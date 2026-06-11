import { useAudioStore, type VoiceState } from '../../state/audio-store.js';
import { useSessionStore } from '../../state/session-store.js';
import { useSession } from '../../hooks/useSession.js';
import { motion, AnimatePresence } from 'framer-motion';
import { sendEvent } from '../../lib/ws-client.js';
import { VoiceHelp } from './VoiceHelp.js';
import { VoiceOrb } from '../primitives/VoiceOrb.js';
import { MicToggle } from './MicToggle.js';

// NarrationBar is now a CONTROL strip only — Hermes's spoken text
// lives in HermesText above this bar. Keeping the voice orb (live
// signal of mic/speaking state) and the area progress dots; the
// line-clamp-2 prose section is gone (HermesText shows the full
// stream, expandable).
const STATE_LABEL: Record<VoiceState, string> = {
  speaking: 'speaking',
  listening: 'listening',
  hearing: 'hearing you',
  processing: 'on it — thinking',
  idle: 'mic off',
};

export function NarrationBar() {
  const voiceState = useAudioStore(s => s.voiceState);
  const floorPhase = useAudioStore(s => s.floorPhase);
  const state = useSessionStore(s => s.state);
  const { areas } = useSession();

  // "Thinking" covers the dead-air gap between the user finishing and the
  // first reply chunk: voiceState 'processing' (utterance shipped) OR the
  // floor sitting at 'awaiting-response' (reply not started yet). The user
  // must see "I heard you, working" — never "paused" or "listening" — through
  // the whole 1.5–12s wait (live bug 2026-06-10).
  const thinking = voiceState === 'processing' || floorPhase === 'awaiting-response';
  // A genuine session pause is the only thing that should ever say "paused".
  const label = state.paused ? 'paused' : thinking ? STATE_LABEL.processing : STATE_LABEL[voiceState];
  const orbState = state.paused ? 'idle' : thinking ? 'processing' : voiceState;
  const dotColor = voiceState === 'hearing' ? 'var(--sig-okay)' : thinking ? 'var(--amber-400)' : null;

  return (
    <div
      className="narration-bar flex items-center gap-6"
      style={{
        padding: '14px 24px',
        borderTop: '1px solid oklch(1 0 0 / 0.05)',
        background: 'color-mix(in oklch, var(--ink-050) 92%, transparent)',
        backdropFilter: 'blur(20px)',
      }}
    >
      <div className="flex items-center gap-4 flex-none">
        <VoiceOrb state={orbState} size={60} />
        <div style={{ minWidth: 104 }}>
          <div
            className="font-mono"
            style={{
              fontSize: 9.5,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: voiceState === 'hearing' ? 'var(--sig-okay)' : 'var(--cream-500)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {dotColor && (
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: dotColor,
                  boxShadow: `0 0 8px ${dotColor}`,
                }}
              />
            )}
            {voiceState === 'hearing' ? 'Mic live' : 'Voice'}
          </div>
          <AnimatePresence mode="wait">
            <motion.div
              key={label}
              data-testid="voice-status-label"
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.15 }}
              className="font-serif mt-0.5"
              style={{ fontSize: 16, fontStyle: 'italic', color: 'var(--amber-400)', letterSpacing: '-0.005em' }}
            >
              {label}
            </motion.div>
          </AnimatePresence>
          {/* PTT discoverability: the core interaction of the product had
              zero on-screen affordance (only a hover tooltip on MicToggle). */}
          {voiceState === 'idle' && !state.paused && (
            <div
              className="font-mono flex items-center"
              style={{ fontSize: 9, letterSpacing: '0.06em', color: 'var(--cream-500)', marginTop: 4, gap: 2, opacity: 0.85 }}
              data-testid="ptt-hint"
            >
              <span className="kc" style={{ minWidth: 34, height: 15, fontSize: 8.5, padding: '0 4px' }}>space</span>
              hold to talk
            </div>
          )}
        </div>
      </div>

      {areas.length > 0 && (
        <div className="flex items-center gap-1.5" aria-label="Area progress">
          {areas.map((_, i) => {
            const current = i === (state.areaIndex ?? -1);
            const past = i < (state.areaIndex ?? 0);
            return (
              <span
                key={i}
                className="rounded-full"
                style={{
                  width: current ? 6 : 4,
                  height: current ? 6 : 4,
                  background: current ? 'var(--amber-400)' : past ? 'var(--cream-500)' : 'oklch(1 0 0 / 0.08)',
                  boxShadow: current ? '0 0 6px var(--amber-400)' : 'none',
                  transition: 'all 0.2s ease-out',
                }}
              />
            );
          })}
        </div>
      )}

      {/* Spacer pushes the controls to the right edge. Hermes's text
          lives in HermesText above this bar; nothing prose-y here. */}
      <div className="flex-1" />


      <div className="nb-controls flex items-center gap-2 flex-none">
        <MicToggle />
        <button
          type="button"
          onClick={() => sendEvent({ type: 'command:previous' })}
          className="btn btn-ghost"
          style={{ padding: '8px 12px', fontSize: 12 }}
          title='Previous (or say "go back")'
        >
          <span className="kc">←</span>
          Back
        </button>
        <button
          type="button"
          onClick={() => sendEvent(state.paused ? { type: 'command:resume' } : { type: 'command:pause' })}
          className="btn btn-ghost"
          style={{ padding: '8px 12px', fontSize: 12 }}
          title={state.paused ? 'Click to resume' : 'Click to pause'}
        >
          {state.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={() => sendEvent({ type: 'command:skip' })}
          className="btn btn-ghost"
          style={{ padding: '8px 12px', fontSize: 12 }}
          title='or say "skip"'
        >
          Skip
          <span className="kc">→</span>
        </button>
        <VoiceHelp />
      </div>
    </div>
  );
}

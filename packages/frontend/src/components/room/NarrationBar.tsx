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
  processing: 'thinking',
  idle: 'paused',
};

export function NarrationBar() {
  const voiceState = useAudioStore(s => s.voiceState);
  const state = useSessionStore(s => s.state);
  const { areas } = useSession();

  return (
    <div
      className="flex items-center gap-6"
      style={{
        padding: '14px 24px',
        borderTop: '1px solid oklch(1 0 0 / 0.05)',
        background: 'color-mix(in oklch, var(--ink-050) 92%, transparent)',
        backdropFilter: 'blur(20px)',
      }}
    >
      <div className="flex items-center gap-4 flex-none">
        <VoiceOrb state={voiceState} size={60} />
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
            {voiceState === 'hearing' && (
              <span
                style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: 'var(--sig-okay)',
                  boxShadow: '0 0 8px var(--sig-okay)',
                }}
              />
            )}
            {voiceState === 'hearing' ? 'Mic live' : 'Voice'}
          </div>
          <AnimatePresence mode="wait">
            <motion.div
              key={voiceState}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.15 }}
              className="font-serif mt-0.5"
              style={{ fontSize: 16, fontStyle: 'italic', color: 'var(--amber-400)', letterSpacing: '-0.005em' }}
            >
              {STATE_LABEL[voiceState]}
            </motion.div>
          </AnimatePresence>
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


      <div className="flex items-center gap-2 flex-none">
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

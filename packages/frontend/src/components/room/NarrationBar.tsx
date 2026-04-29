import { useAudioStore, type VoiceState } from '../../state/audio-store.js';
import { useSessionStore } from '../../state/session-store.js';
import { useSession } from '../../hooks/useSession.js';
import { motion, AnimatePresence } from 'framer-motion';
import { sendEvent } from '../../lib/ws-client.js';
import { VoiceHelp } from './VoiceHelp.js';
import { VoiceOrb } from '../primitives/VoiceOrb.js';
import { MicToggle } from './MicToggle.js';

const STATE_LABEL: Record<VoiceState, string> = {
  speaking: 'speaking',
  listening: 'listening',
  hearing: 'hearing you',
  processing: 'thinking',
  idle: 'paused',
};

export function NarrationBar() {
  const { currentSegment, voiceState } = useAudioStore();
  const state = useSessionStore(s => s.state);
  const { areas } = useSession();

  const idleText =
    state.phase === 'ANALYZING' ? 'Analyzing repository…' :
    voiceState === 'hearing' ? 'Go ahead — I\'m listening.' :
    voiceState === 'processing' ? 'Let me think about that…' :
    'Say something, or I\'ll keep going.';

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

      <div className="flex-1 min-w-0">
        <AnimatePresence mode="wait">
          {currentSegment ? (
            <motion.p
              key={currentSegment.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.25 }}
              className="narration line-clamp-2"
              style={{ fontSize: 18 }}
            >
              {currentSegment.text}
            </motion.p>
          ) : (
            <motion.p
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="narration"
              style={{ fontSize: 16, color: 'var(--cream-500)' }}
            >
              {idleText}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

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

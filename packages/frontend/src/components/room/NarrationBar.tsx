import { useAudioStore, type VoiceState } from '../../state/audio-store.js';
import { useSessionStore } from '../../state/session-store.js';
import { useSession } from '../../hooks/useSession.js';
import { motion, AnimatePresence } from 'framer-motion';
import { sendEvent } from '../../lib/ws-client.js';
import { VoiceHelp } from './VoiceHelp.js';

const STATE_CONFIG: Record<VoiceState, { color: string; borderColor: string; label: string }> = {
  speaking: { color: 'var(--color-accent)', borderColor: 'rgba(99, 102, 241, 0.4)', label: 'AI Speaking' },
  listening: { color: 'var(--color-text-muted)', borderColor: 'var(--color-border)', label: 'Listening' },
  hearing: { color: 'var(--color-green)', borderColor: 'rgba(52, 211, 153, 0.5)', label: 'Hearing you' },
  processing: { color: 'var(--color-yellow)', borderColor: 'rgba(251, 191, 36, 0.4)', label: 'Thinking...' },
};

export function NarrationBar() {
  const { currentSegment, isPlaying, voiceState } = useAudioStore();
  const state = useSessionStore(s => s.state);
  const { areas } = useSession();
  const config = STATE_CONFIG[voiceState];

  return (
    <motion.div
      animate={{ borderColor: config.borderColor }}
      transition={{ duration: 0.3 }}
      className="h-20 border-t-2 bg-[var(--color-surface)] flex items-center px-6 gap-4"
    >
      {/* Voice state indicator */}
      <div className="flex items-center gap-3 min-w-[140px]">
        {/* Animated state icon */}
        <motion.div
          animate={{
            scale: voiceState === 'hearing' ? [1, 1.2, 1] : voiceState === 'speaking' ? [1, 1.05, 1] : 1,
            boxShadow: voiceState === 'listening'
              ? '0 0 0px transparent'
              : `0 0 ${voiceState === 'hearing' ? '16px' : '10px'} ${config.borderColor}`,
          }}
          transition={{
            duration: voiceState === 'hearing' ? 0.6 : 1.5,
            repeat: voiceState === 'listening' ? 0 : Infinity,
            repeatType: 'reverse',
          }}
          className="w-10 h-10 flex items-center justify-center rounded-full border-2 transition-colors"
          style={{ borderColor: config.color }}
        >
          {voiceState === 'speaking' && (
            <WaveformBars color={config.color} />
          )}
          {voiceState === 'listening' && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={config.color} strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            </svg>
          )}
          {voiceState === 'hearing' && (
            <WaveformBars color={config.color} active />
          )}
          {voiceState === 'processing' && (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
              className="w-4 h-4 border-2 rounded-full"
              style={{ borderColor: config.color, borderTopColor: 'transparent' }}
            />
          )}
        </motion.div>

        {/* State label */}
        <AnimatePresence mode="wait">
          <motion.span
            key={voiceState}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="text-xs font-medium"
            style={{ color: config.color }}
          >
            {config.label}
          </motion.span>
        </AnimatePresence>
      </div>

      {/* Progress dots */}
      {areas.length > 0 && (
        <div className="flex items-center gap-1.5 mx-2">
          {areas.map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === (state.areaIndex ?? -1)
                  ? 'bg-[var(--color-accent)]'
                  : i < (state.areaIndex ?? 0)
                  ? 'bg-[var(--color-text-muted)]/50'
                  : 'bg-[var(--color-border)]'
              }`}
            />
          ))}
        </div>
      )}

      {/* Narration text / subtitle */}
      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          {currentSegment ? (
            <motion.p
              key={currentSegment.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="text-sm text-[var(--color-text)] leading-relaxed line-clamp-2"
            >
              {currentSegment.text}
            </motion.p>
          ) : (
            <motion.p
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-sm text-[var(--color-text-muted)] italic"
            >
              {state.phase === 'ANALYZING' ? 'Analyzing repository...' :
               voiceState === 'hearing' ? 'Go ahead, I\'m listening...' :
               voiceState === 'processing' ? 'Let me think about that...' :
               'Say something or I\'ll continue the tour...'}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Compact nav controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => sendEvent({ type: 'command:previous' })}
          className="px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
          title='Previous (or say "go back")'
        >
          &larr; Back
        </button>
        <button
          onClick={() => sendEvent(state.paused ? { type: 'command:resume' } : { type: 'command:pause' })}
          className="px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
          title={state.paused ? 'or say "resume"' : 'or say "pause"'}
        >
          {state.paused ? '\u25B6 Resume' : '\u23F8 Pause'}
        </button>
        <button
          onClick={() => sendEvent({ type: 'command:skip' })}
          className="px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
          title='or say "skip"'
        >
          Skip \u2192
        </button>
        <div className="relative">
          <VoiceHelp />
        </div>
      </div>
    </motion.div>
  );
}

/** Small animated waveform bars */
function WaveformBars({ color, active }: { color: string; active?: boolean }) {
  return (
    <div className="flex items-center gap-[2px] h-4">
      {[0, 1, 2, 3].map(i => (
        <motion.div
          key={i}
          className="w-[3px] rounded-full"
          style={{ background: color }}
          animate={{
            height: active
              ? [4, 14, 8, 16, 6]
              : [3, 10, 6, 12, 4],
          }}
          transition={{
            duration: active ? 0.5 : 0.8,
            repeat: Infinity,
            repeatType: 'reverse',
            delay: i * 0.1,
          }}
        />
      ))}
    </div>
  );
}
